import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers"
import type { ContractTransactionResponse } from "ethers"
import {
  RecoveryImmutableValues,
  verifyRecoveryBytecode,
} from "../helpers/verify-recovery-bytecode"
import { buildRecoveryBatchPayloads } from "../helpers/recovery-preflight"

const PORTAL_DEPOSITS_SLOT = 0n
const PORTAL_FEE_INFO_SLOT = 5n
const PORTAL_TBTC_TOKEN_SLOT = 6n

const RECOVERY_AMOUNT = ethers.parseEther("1")
const FIRST_DEBT = ethers.parseEther("0.7")
const SECOND_DEBT = ethers.parseEther("0.6")
const SECOND_SETTLEMENT = RECOVERY_AMOUNT - FIRST_DEBT
const TOTAL_DEBT = FIRST_DEBT + SECOND_DEBT
const FIRST_BALANCE = ethers.parseEther("1.2")
const SECOND_BALANCE = ethers.parseEther("1")

// Mirrors the live Portal's tBTC fee configuration so the recovery's fee
// accounting (_updateFee and the collateral reserve check) is exercised by
// every test instead of being dead code against a zero fee.
const ANNUAL_FEE_PERCENT = 2n
const FEE_PER_SECOND =
  (ANNUAL_FEE_PERCENT * 10n ** 16n) / (365n * 24n * 60n * 60n)
const FEE_PRECISION = 10n ** 18n

const SKIP_REASON_DEPOSIT_NOT_FOUND = 0
const SKIP_REASON_DEPOSIT_MIGRATING = 1
const SKIP_REASON_DEBT_ALREADY_REPAID = 2
const SKIP_REASON_UNDERCOLLATERALIZED = 3
const SKIP_REASON_RECEIPT_HOLDER_WOULD_BE_STRANDED = 4

const abiCoder = ethers.AbiCoder.defaultAbiCoder()

function storageWord(value: bigint): string {
  return ethers.toBeHex(value, 32)
}

function mappingEntrySlot(
  keyType: "address" | "uint256",
  key: string | bigint,
  mappingSlot: bigint,
): bigint {
  return BigInt(
    ethers.keccak256(abiCoder.encode([keyType, "uint256"], [key, mappingSlot])),
  )
}

function depositStorageSlot(
  depositor: string,
  token: string,
  depositId: bigint,
): bigint {
  const depositorSlot = mappingEntrySlot(
    "address",
    depositor,
    PORTAL_DEPOSITS_SLOT,
  )
  const tokenSlot = mappingEntrySlot("address", token, depositorSlot)
  return mappingEntrySlot("uint256", depositId, tokenSlot)
}

async function setStorageAt(
  contractAddress: string,
  slot: bigint,
  value: bigint,
): Promise<void> {
  await network.provider.send("hardhat_setStorageAt", [
    contractAddress,
    storageWord(slot),
    storageWord(value),
  ])
}

async function seedDeposit(
  portal: string,
  depositor: string,
  token: string,
  depositId: bigint,
  balance: bigint,
  receiptMinted: bigint,
): Promise<void> {
  const baseSlot = depositStorageSlot(depositor, token, depositId)

  // DepositInfo slot 0 packs balance, unlockAt, and receiptMinted.
  const packedDeposit = balance + receiptMinted * 2n ** 128n
  await setStorageAt(portal, baseSlot, packedDeposit)
}

async function setDepositMigrationState(
  portal: string,
  depositor: string,
  token: string,
  depositId: bigint,
  state: bigint,
): Promise<void> {
  // DepositInfo slot 1 packs feeOwed, lastFeeIntegral, tbtcMigrationState,
  // and autoBridgingOptOut; the fixture keeps the first two at zero.
  const baseSlot = depositStorageSlot(depositor, token, depositId)
  await setStorageAt(portal, baseSlot + 1n, state * 2n ** 184n)
}

function feeIntegralOver(seconds: bigint): bigint {
  return seconds * FEE_PER_SECOND
}

function feeAccrued(integralDiff: bigint, minted: bigint): bigint {
  return (integralDiff * minted) / FEE_PRECISION
}

async function deployFixture() {
  const [
    governance,
    receiptPayer,
    collateralRecipient,
    depositor,
    otherHolder,
  ] = await ethers.getSigners()

  const Timelock = await ethers.getContractFactory("Timelock")
  const timelock = await Timelock.deploy(
    0,
    [await governance.getAddress()],
    [await governance.getAddress()],
  )
  await timelock.waitForDeployment()

  const Portal = await ethers.getContractFactory("Portal")
  const portal = await upgrades.deployProxy(Portal, [[]], {
    kind: "transparent",
    initialOwner: await timelock.getAddress(),
  })
  await portal.waitForDeployment()

  const portalAddress = await portal.getAddress()
  const proxyAdmin = await upgrades.erc1967.getAdminAddress(portalAddress)
  const originalImplementation =
    await upgrades.erc1967.getImplementationAddress(portalAddress)

  const MockERC20 = await ethers.getContractFactory("MockERC20")
  const tbtc = await MockERC20.deploy(
    "Test tBTC",
    "tBTC",
    ethers.parseEther("100"),
  )
  await tbtc.waitForDeployment()

  const MockSTBTC = await ethers.getContractFactory("MockSTBTC")
  const stbtc = await MockSTBTC.deploy()
  await stbtc.waitForDeployment()

  const tbtcAddress = await tbtc.getAddress()
  const stbtcAddress = await stbtc.getAddress()

  // Recreate the relevant live Portal state. The current implementation no
  // longer exposes the historical receipt-minting configuration functions.
  await setStorageAt(portalAddress, PORTAL_TBTC_TOKEN_SLOT, BigInt(tbtcAddress))

  const feeSlot = mappingEntrySlot("address", tbtcAddress, PORTAL_FEE_INFO_SLOT)
  const latestBlock = await ethers.provider.getBlock("latest")
  const lastFeeUpdateAt = BigInt(latestBlock!.timestamp)
  const packedFee =
    TOTAL_DEBT +
    lastFeeUpdateAt * 2n ** 96n +
    // A live-like nonzero annual fee and a 100% historical mint cap.
    ANNUAL_FEE_PERCENT * 2n ** 216n +
    100n * 2n ** 224n

  await setStorageAt(portalAddress, feeSlot, packedFee)
  await setStorageAt(portalAddress, feeSlot + 1n, BigInt(stbtcAddress))

  await seedDeposit(
    portalAddress,
    await depositor.getAddress(),
    tbtcAddress,
    1n,
    FIRST_BALANCE,
    FIRST_DEBT,
  )
  await seedDeposit(
    portalAddress,
    await depositor.getAddress(),
    tbtcAddress,
    2n,
    SECOND_BALANCE,
    SECOND_DEBT,
  )

  await tbtc.transfer(portalAddress, FIRST_BALANCE + SECOND_BALANCE)

  // Headroom above TOTAL_DEBT lets tests mint extra stBTC to model a
  // depositor acquiring receipt tokens before execution.
  await stbtc.updateDebtAllowance(portalAddress, TOTAL_DEBT * 2n)
  await network.provider.send("hardhat_setBalance", [
    portalAddress,
    ethers.toBeHex(ethers.parseEther("1")),
  ])
  await network.provider.send("hardhat_impersonateAccount", [portalAddress])
  const portalSigner = await ethers.getSigner(portalAddress)
  await stbtc
    .connect(portalSigner)
    .mintReceipt(await receiptPayer.getAddress(), RECOVERY_AMOUNT)
  await stbtc
    .connect(portalSigner)
    .mintReceipt(await otherHolder.getAddress(), TOTAL_DEBT - RECOVERY_AMOUNT)
  await network.provider.send("hardhat_stopImpersonatingAccount", [
    portalAddress,
  ])

  await stbtc.connect(receiptPayer).approve(portalAddress, RECOVERY_AMOUNT)

  const depositorAddress = await depositor.getAddress()
  const settlements = [
    {
      depositor: depositorAddress,
      depositId: 1n,
      amount: FIRST_DEBT,
    },
    {
      depositor: depositorAddress,
      depositId: 2n,
      amount: SECOND_SETTLEMENT,
    },
  ]
  // The reviewed active-deposit context for the stranding guard, mirroring
  // the manifest's depositorActiveDepositIds.
  const depositorContexts = [
    { depositor: depositorAddress, activeDepositIds: [1n, 2n] },
  ]

  const Recovery = await ethers.getContractFactory("PortalStbtcRecovery")
  const constructorArgs = [
    portalAddress,
    proxyAdmin,
    await receiptPayer.getAddress(),
    await collateralRecipient.getAddress(),
    tbtcAddress,
    stbtcAddress,
    RECOVERY_AMOUNT,
  ]
  const recoveryImplementation = await upgrades.prepareUpgrade(
    portalAddress,
    Recovery,
    {
      kind: "transparent",
      constructorArgs,
      unsafeAllow: ["constructor", "state-variable-immutable"],
    },
  )

  const proxyAdminInterface = new ethers.Interface([
    "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
  ])

  return {
    governance,
    receiptPayer,
    collateralRecipient,
    depositor,
    otherHolder,
    portal,
    portalAddress,
    proxyAdmin,
    originalImplementation,
    tbtc,
    stbtc,
    tbtcAddress,
    stbtcAddress,
    lastFeeUpdateAt,
    timelock,
    Recovery,
    recoveryImplementation,
    proxyAdminInterface,
    settlements,
    depositorContexts,
  }
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>

type Settlements = Fixture["settlements"]

type DepositorContexts = Fixture["depositorContexts"]

async function recoveryImmutableValues(
  fixture: Fixture,
): Promise<RecoveryImmutableValues> {
  return {
    EXPECTED_PORTAL: fixture.portalAddress,
    RECOVERY_AUTHORITY: fixture.proxyAdmin,
    RECEIPT_PAYER: await fixture.receiptPayer.getAddress(),
    COLLATERAL_RECIPIENT: await fixture.collateralRecipient.getAddress(),
    EXPECTED_TBTC: fixture.tbtcAddress,
    EXPECTED_RECEIPT_TOKEN: fixture.stbtcAddress,
    EXPECTED_MAX_RECOVERY_AMOUNT: RECOVERY_AMOUNT,
  }
}

// Mints extra stBTC to an address the way the Portal would, modelling a
// depositor acquiring receipt tokens (or receiving a donation) between
// manifest review and batch execution.
async function mintStbtcTo(
  fixture: Fixture,
  recipient: string,
  amount: bigint,
): Promise<void> {
  await network.provider.send("hardhat_impersonateAccount", [
    fixture.portalAddress,
  ])
  const portalSigner = await ethers.getSigner(fixture.portalAddress)
  await fixture.stbtc.connect(portalSigner).mintReceipt(recipient, amount)
  await network.provider.send("hardhat_stopImpersonatingAccount", [
    fixture.portalAddress,
  ])
}

async function scheduleRecovery(
  fixture: Fixture,
  settlements: Settlements,
  salt: string,
  implementation?: string,
  depositorContexts?: DepositorContexts,
) {
  const recoveryCall = fixture.Recovery.interface.encodeFunctionData(
    "recoverTbtc",
    [settlements, depositorContexts ?? fixture.depositorContexts],
  )
  // The exact helper whose output the preflight prints for governance —
  // executing it here keeps the printed batch and the tested batch one
  // artifact.
  const { targets, values, payloads } = buildRecoveryBatchPayloads({
    portal: fixture.portalAddress,
    proxyAdmin: fixture.proxyAdmin,
    recoveryImplementation: (implementation ??
      fixture.recoveryImplementation) as string,
    originalImplementation: fixture.originalImplementation,
    recoverCalldata: recoveryCall,
  })
  const predecessor = ethers.ZeroHash

  await fixture.timelock.scheduleBatch(
    targets,
    values,
    payloads,
    predecessor,
    salt,
    0,
  )

  return fixture.timelock.executeBatch(
    targets,
    values,
    payloads,
    predecessor,
    salt,
  )
}

async function executionTimestamp(
  transaction: ContractTransactionResponse,
): Promise<bigint> {
  const receipt = await transaction.wait()
  const block = await ethers.provider.getBlock(receipt!.blockNumber)
  return BigInt(block!.timestamp)
}

describe("PortalStbtcRecovery", () => {
  describe("settlement", () => {
    it("settles stBTC for tBTC and restores Portal in one timelock batch", async () => {
      const fixture = await loadFixture(deployFixture)
      const recipient = await fixture.collateralRecipient.getAddress()
      const payer = await fixture.receiptPayer.getAddress()
      const depositor = await fixture.depositor.getAddress()

      await time.increase(30 * 24 * 60 * 60)

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("successful-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, RECOVERY_AMOUNT)
      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(depositor, fixture.tbtcAddress, 1n, FIRST_DEBT)
      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(depositor, fixture.tbtcAddress, 2n, SECOND_SETTLEMENT)

      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)

      const executedAt = await executionTimestamp(transaction)
      const expectedIntegral = feeIntegralOver(
        executedAt - fixture.lastFeeUpdateAt,
      )
      const firstFee = feeAccrued(expectedIntegral, FIRST_DEBT)
      const secondFee = feeAccrued(expectedIntegral, SECOND_DEBT)
      expect(firstFee).to.be.greaterThan(0n)

      const firstDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        1n,
      )
      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      const fee = await fixture.portal.feeInfo(fixture.tbtcAddress)

      expect(firstDeposit.balance).to.equal(FIRST_BALANCE - FIRST_DEBT)
      expect(firstDeposit.receiptMinted).to.equal(0)
      // Fees accrued before settlement are preserved, not settled away.
      expect(firstDeposit.feeOwed).to.equal(firstFee)
      expect(firstDeposit.lastFeeIntegral).to.equal(expectedIntegral)
      expect(secondDeposit.balance).to.equal(SECOND_BALANCE - SECOND_SETTLEMENT)
      expect(secondDeposit.receiptMinted).to.equal(
        SECOND_DEBT - SECOND_SETTLEMENT,
      )
      expect(secondDeposit.feeOwed).to.equal(secondFee)
      expect(secondDeposit.lastFeeIntegral).to.equal(expectedIntegral)
      expect(fee.totalMinted).to.equal(TOTAL_DEBT - RECOVERY_AMOUNT)
      expect(fee.feeIntegral).to.equal(expectedIntegral)
      expect(fee.lastFeeUpdateAt).to.equal(executedAt)

      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(RECOVERY_AMOUNT)
      expect(await fixture.tbtc.balanceOf(fixture.portalAddress)).to.equal(
        FIRST_BALANCE + SECOND_BALANCE - RECOVERY_AMOUNT,
      )
      expect(await fixture.stbtc.balanceOf(payer)).to.equal(0)
      expect(await fixture.stbtc.currentDebt(fixture.portalAddress)).to.equal(
        TOTAL_DEBT - RECOVERY_AMOUNT,
      )
      expect(
        await fixture.stbtc.allowance(payer, fixture.portalAddress),
      ).to.equal(0)
    })

    it("clamps a settlement when a third party repays during the delay", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      // A 1 wei repayment on deposit 1 after the manifest was reviewed. It
      // must reduce the recovered amount by 1 wei, not veto the batch.
      await seedDeposit(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        1n,
        FIRST_BALANCE,
        FIRST_DEBT - 1n,
      )

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("clamped-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(depositor, fixture.tbtcAddress, 1n, FIRST_DEBT - 1n)
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, RECOVERY_AMOUNT - 1n)

      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)

      const firstDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        1n,
      )
      expect(firstDeposit.receiptMinted).to.equal(0)
      expect(firstDeposit.balance).to.equal(FIRST_BALANCE - (FIRST_DEBT - 1n))

      expect(await fixture.stbtc.balanceOf(payer)).to.equal(1n)
      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(
        RECOVERY_AMOUNT - 1n,
      )
    })

    it("absorbs a small stBTC acquisition into the owner's unsettled debt", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()
      const acquired = ethers.parseEther("0.1")

      // The owner's total debt (1.3) minus the requested settlement (1.0)
      // leaves 0.3 of unsettled debt — more than the acquired balance, so
      // the per-owner guard must not clamp anything. (A per-entry guard
      // would wrongly deduct the balance from each deposit independently.)
      await mintStbtcTo(fixture, depositor, acquired)

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("absorbed-acquisition-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, RECOVERY_AMOUNT)

      const firstDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        1n,
      )
      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      const remainingDebt =
        BigInt(firstDeposit.receiptMinted) + BigInt(secondDeposit.receiptMinted)
      expect(remainingDebt).to.equal(TOTAL_DEBT - RECOVERY_AMOUNT)
      expect(remainingDebt).to.be.greaterThanOrEqual(acquired)
      expect(await fixture.stbtc.balanceOf(depositor)).to.equal(acquired)
      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(RECOVERY_AMOUNT)
    })

    it("clamps per owner, not per entry, when holdings exceed the unsettled debt", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()
      const acquired = ethers.parseEther("0.4")
      // Owner capacity = total debt (1.3) - balance (0.4) = 0.9: deposit 1
      // settles in full (0.7) and deposit 2 is clamped once, to 0.2. A
      // per-entry guard would instead deduct 0.4 from both entries and
      // settle only 0.6 — an under-recovery amplification.
      const expectedSettled = TOTAL_DEBT - acquired

      await mintStbtcTo(fixture, depositor, acquired)

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("owner-clamped-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(depositor, fixture.tbtcAddress, 1n, FIRST_DEBT)
      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          2n,
          expectedSettled - FIRST_DEBT,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, expectedSettled)

      const firstDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        1n,
      )
      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      const remainingDebt =
        BigInt(firstDeposit.receiptMinted) + BigInt(secondDeposit.receiptMinted)
      // The guard's invariant is exact: remaining debt equals the owner's
      // holdings, so every token they hold stays redeemable.
      expect(remainingDebt).to.equal(acquired)
      expect(await fixture.stbtc.balanceOf(depositor)).to.equal(acquired)
      expect(await fixture.stbtc.balanceOf(payer)).to.equal(
        RECOVERY_AMOUNT - expectedSettled,
      )
      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(expectedSettled)
      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)
    })

    it("emits the stranding skip when the owner's capacity is exhausted", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()
      // Capacity = total debt (1.3) - holdings (0.6) = 0.7: deposit 1
      // consumes all of it and deposit 2 must be skipped with the dedicated
      // stranding reason, not silently dropped or mislabeled.
      const acquired = ethers.parseEther("0.6")

      await mintStbtcTo(fixture, depositor, acquired)

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("stranding-skip-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettled")
        .withArgs(depositor, fixture.tbtcAddress, 1n, FIRST_DEBT)
      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettlementSkipped")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          2n,
          SKIP_REASON_RECEIPT_HOLDER_WOULD_BE_STRANDED,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)

      const firstDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        1n,
      )
      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      const remainingDebt =
        BigInt(firstDeposit.receiptMinted) + BigInt(secondDeposit.receiptMinted)
      expect(remainingDebt).to.equal(acquired)
      expect(await fixture.stbtc.balanceOf(depositor)).to.equal(acquired)
    })

    it("skips a deposit repaid in full and settles the remainder", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      await seedDeposit(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        2n,
        SECOND_BALANCE,
        0n,
      )

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("skip-repaid-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettlementSkipped")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          2n,
          SKIP_REASON_DEBT_ALREADY_REPAID,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)

      expect(await fixture.stbtc.balanceOf(payer)).to.equal(
        RECOVERY_AMOUNT - FIRST_DEBT,
      )
      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(FIRST_DEBT)

      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      expect(secondDeposit.balance).to.equal(SECOND_BALANCE)
      expect(secondDeposit.receiptMinted).to.equal(0)
    })

    it("skips a settlement whose deposit does not exist", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      // Deposit 99 was in the reviewed context but has since been withdrawn
      // entirely (balance 0), which is the drift this skip reason exists for.
      const settlements = [
        fixture.settlements[0],
        { ...fixture.settlements[1], depositId: 99n },
      ]

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        settlements,
        ethers.id("skip-missing-stbtc-recovery"),
        undefined,
        [{ depositor, activeDepositIds: [1n, 2n, 99n] }],
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettlementSkipped")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          99n,
          SKIP_REASON_DEPOSIT_NOT_FOUND,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)
    })

    it("skips a deposit that entered tBTC migration", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      await setDepositMigrationState(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        2n,
        1n,
      )

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("skip-migrating-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettlementSkipped")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          2n,
          SKIP_REASON_DEPOSIT_MIGRATING,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)

      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      expect(secondDeposit.receiptMinted).to.equal(SECOND_DEBT)
    })

    it("skips a deposit that is no longer fully collateralized", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      await seedDeposit(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        2n,
        SECOND_DEBT - 1n,
        SECOND_DEBT,
      )

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("skip-undercollateralized-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "ReceiptDebtSettlementSkipped")
        .withArgs(
          depositor,
          fixture.tbtcAddress,
          2n,
          SKIP_REASON_UNDERCOLLATERALIZED,
        )
      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)

      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      expect(secondDeposit.receiptMinted).to.equal(SECOND_DEBT)
      expect(secondDeposit.balance).to.equal(SECOND_DEBT - 1n)
    })

    it("settles a smaller reviewed round below the immutable maximum", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()
      const recipient = await fixture.collateralRecipient.getAddress()
      const depositor = await fixture.depositor.getAddress()

      // A residual round reuses the deployed implementation with fresh,
      // smaller calldata; the immutable amount is an upper bound, not an
      // exact total.
      const settlements = [fixture.settlements[0]]

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      const transaction = await scheduleRecovery(
        fixture,
        settlements,
        ethers.id("residual-round-stbtc-recovery"),
      )

      await expect(transaction)
        .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
        .withArgs(payer, recipient, FIRST_DEBT)

      expect(await fixture.tbtc.balanceOf(recipient)).to.equal(FIRST_DEBT)
      expect(await fixture.stbtc.balanceOf(payer)).to.equal(
        RECOVERY_AMOUNT - FIRST_DEBT,
      )
      // The unused approval remains for the payer to revoke or roll into a
      // follow-up round.
      expect(
        await fixture.stbtc.allowance(payer, fixture.portalAddress),
      ).to.equal(RECOVERY_AMOUNT - FIRST_DEBT)
      const secondDeposit = await fixture.portal.deposits(
        depositor,
        fixture.tbtcAddress,
        2n,
      )
      expect(secondDeposit.receiptMinted).to.equal(SECOND_DEBT)
    })
  })

  describe("atomic failure", () => {
    it("rolls back everything if the requested total exceeds the maximum", async () => {
      const fixture = await loadFixture(deployFixture)
      const badSettlements = [
        fixture.settlements[0],
        {
          ...fixture.settlements[1],
          amount: SECOND_SETTLEMENT + 1n,
        },
      ]

      const transaction = scheduleRecovery(
        fixture,
        badSettlements,
        ethers.id("failed-stbtc-recovery"),
      )

      await expect(transaction).to.be.revertedWithCustomError(
        fixture.Recovery,
        "SettlementTotalExceedsMaximum",
      )

      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)
      expect(
        await fixture.stbtc.balanceOf(await fixture.receiptPayer.getAddress()),
      ).to.equal(RECOVERY_AMOUNT)
      expect(await fixture.tbtc.balanceOf(fixture.portalAddress)).to.equal(
        FIRST_BALANCE + SECOND_BALANCE,
      )
    })

    it("reverts when no settlement can be applied", async () => {
      const fixture = await loadFixture(deployFixture)
      const depositor = await fixture.depositor.getAddress()

      await seedDeposit(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        1n,
        FIRST_BALANCE,
        0n,
      )
      await seedDeposit(
        fixture.portalAddress,
        depositor,
        fixture.tbtcAddress,
        2n,
        SECOND_BALANCE,
        0n,
      )

      const transaction = scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("nothing-settled-stbtc-recovery"),
      )

      await expect(transaction).to.be.revertedWithCustomError(
        fixture.Recovery,
        "NothingSettled",
      )
      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)
      expect(
        await fixture.stbtc.balanceOf(await fixture.receiptPayer.getAddress()),
      ).to.equal(RECOVERY_AMOUNT)
    })

    it("reverts when holdings cover every selected owner's entire debt", async () => {
      const fixture = await loadFixture(deployFixture)
      const depositor = await fixture.depositor.getAddress()

      // The owner holds as much stBTC as their whole active debt: settling
      // anything would strand them, so every entry skips and the batch
      // reverts rather than settling zero. The operation stays retryable
      // and the depositor retains full self-repayment capacity.
      await mintStbtcTo(fixture, depositor, TOTAL_DEBT)

      const transaction = scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("fully-held-stbtc-recovery"),
      )

      await expect(transaction).to.be.revertedWithCustomError(
        fixture.Recovery,
        "NothingSettled",
      )
      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)
      expect(await fixture.stbtc.balanceOf(depositor)).to.equal(TOTAL_DEBT)
      expect(
        await fixture.stbtc.balanceOf(await fixture.receiptPayer.getAddress()),
      ).to.equal(RECOVERY_AMOUNT)
    })

    it("reverts on an empty settlement list", async () => {
      const fixture = await loadFixture(deployFixture)

      await expect(
        scheduleRecovery(fixture, [], ethers.id("empty-stbtc-recovery")),
      ).to.be.revertedWithCustomError(fixture.Recovery, "EmptySettlements")
    })

    it("reverts on a zero settlement amount", async () => {
      const fixture = await loadFixture(deployFixture)
      const settlements = [
        { ...fixture.settlements[0], amount: RECOVERY_AMOUNT },
        { ...fixture.settlements[1], amount: 0n },
      ]

      await expect(
        scheduleRecovery(fixture, settlements, ethers.id("zero-amount")),
      ).to.be.revertedWithCustomError(fixture.Recovery, "ZeroSettlementAmount")
    })

    it("reverts when a settlement has no depositor context", async () => {
      const fixture = await loadFixture(deployFixture)

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("missing-context-stbtc-recovery"),
          undefined,
          [],
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "MissingDepositorContext",
      )
    })

    it("reverts when a settled deposit is not in the reviewed context", async () => {
      const fixture = await loadFixture(deployFixture)
      const depositor = await fixture.depositor.getAddress()

      // Deposit 2 exists and is settleable, but the reviewed context lists
      // only deposit 1 — calldata the preflight would refuse to print must
      // not execute on-chain either.
      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("unlisted-deposit-stbtc-recovery"),
          undefined,
          [{ depositor, activeDepositIds: [1n] }],
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "DepositNotInDepositorContext",
      )
    })

    it("reverts on duplicated depositor contexts", async () => {
      const fixture = await loadFixture(deployFixture)

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("duplicate-context-stbtc-recovery"),
          undefined,
          [fixture.depositorContexts[0], fixture.depositorContexts[0]],
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "DuplicateDepositorContext",
      )
    })

    it("reverts on unsorted or empty context deposit ids", async () => {
      const fixture = await loadFixture(deployFixture)
      const depositor = await fixture.depositor.getAddress()

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("unsorted-context-stbtc-recovery"),
          undefined,
          [{ depositor, activeDepositIds: [2n, 1n] }],
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "InvalidDepositorContext",
      )

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("empty-context-stbtc-recovery"),
          undefined,
          [{ depositor, activeDepositIds: [] }],
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "InvalidDepositorContext",
      )
    })

    it("blocks reentrancy from the receipt token", async () => {
      const fixture = await loadFixture(deployFixture)
      const payer = await fixture.receiptPayer.getAddress()

      const Reentrant = await ethers.getContractFactory("MockReentrantSTBTC")
      const reentrant = await Reentrant.deploy()
      await reentrant.waitForDeployment()
      const reentrantAddress = await reentrant.getAddress()

      const feeSlot = mappingEntrySlot(
        "address",
        fixture.tbtcAddress,
        PORTAL_FEE_INFO_SLOT,
      )
      await setStorageAt(
        fixture.portalAddress,
        feeSlot + 1n,
        BigInt(reentrantAddress),
      )

      await reentrant.mintReceipt(payer, RECOVERY_AMOUNT)
      await reentrant
        .connect(fixture.receiptPayer)
        .approve(fixture.portalAddress, RECOVERY_AMOUNT)
      await reentrant.setAttack(true)

      const reentrantRecovery = await fixture.Recovery.deploy(
        fixture.portalAddress,
        fixture.proxyAdmin,
        payer,
        await fixture.collateralRecipient.getAddress(),
        fixture.tbtcAddress,
        reentrantAddress,
        RECOVERY_AMOUNT,
      )
      await reentrantRecovery.waitForDeployment()

      const transaction = scheduleRecovery(
        fixture,
        fixture.settlements,
        ethers.id("reentrant-stbtc-recovery"),
        await reentrantRecovery.getAddress(),
      )

      await expect(transaction).to.be.revertedWithCustomError(
        fixture.Recovery,
        "ReentrancyGuardReentrantCall",
      )
      expect(
        await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
      ).to.equal(fixture.originalImplementation)
      expect(await reentrant.balanceOf(payer)).to.equal(RECOVERY_AMOUNT)
    })
  })

  describe("configuration guards", () => {
    it("rejects calls when not running behind the expected Portal", async () => {
      const fixture = await loadFixture(deployFixture)
      const standalone = fixture.Recovery.attach(fixture.recoveryImplementation)

      await expect(
        standalone.recoverTbtc(fixture.settlements, fixture.depositorContexts),
      ).to.be.revertedWithCustomError(fixture.Recovery, "UnexpectedPortal")
    })

    it("rejects callers other than the Portal ProxyAdmin", async () => {
      const fixture = await loadFixture(deployFixture)

      const install = fixture.proxyAdminInterface.encodeFunctionData(
        "upgradeAndCall",
        [fixture.portalAddress, fixture.recoveryImplementation, "0x"],
      )
      const salt = ethers.id("install-only-stbtc-recovery")
      await fixture.timelock.scheduleBatch(
        [fixture.proxyAdmin],
        [0],
        [install],
        ethers.ZeroHash,
        salt,
        0,
      )
      await fixture.timelock.executeBatch(
        [fixture.proxyAdmin],
        [0],
        [install],
        ethers.ZeroHash,
        salt,
      )

      const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
      await expect(
        recoveryAtPortal
          .connect(fixture.governance)
          .recoverTbtc(fixture.settlements, fixture.depositorContexts),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "UnauthorizedRecoveryCaller",
      )
    })

    it("rejects an unexpected tBTC token", async () => {
      const fixture = await loadFixture(deployFixture)
      const wrongToken = ethers.Wallet.createRandom().address

      const misconfigured = await fixture.Recovery.deploy(
        fixture.portalAddress,
        fixture.proxyAdmin,
        await fixture.receiptPayer.getAddress(),
        await fixture.collateralRecipient.getAddress(),
        wrongToken,
        fixture.stbtcAddress,
        RECOVERY_AMOUNT,
      )
      await misconfigured.waitForDeployment()

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("wrong-tbtc-stbtc-recovery"),
          await misconfigured.getAddress(),
        ),
      ).to.be.revertedWithCustomError(fixture.Recovery, "UnexpectedTbtcToken")
    })

    it("rejects an unexpected receipt token", async () => {
      const fixture = await loadFixture(deployFixture)
      const wrongToken = ethers.Wallet.createRandom().address

      const misconfigured = await fixture.Recovery.deploy(
        fixture.portalAddress,
        fixture.proxyAdmin,
        await fixture.receiptPayer.getAddress(),
        await fixture.collateralRecipient.getAddress(),
        fixture.tbtcAddress,
        wrongToken,
        RECOVERY_AMOUNT,
      )
      await misconfigured.waitForDeployment()

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("wrong-receipt-stbtc-recovery"),
          await misconfigured.getAddress(),
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "UnexpectedReceiptToken",
      )
    })

    it("rejects a receipt token with mismatched decimals", async () => {
      const fixture = await loadFixture(deployFixture)

      const SixDecimals = await ethers.getContractFactory(
        "MockERC20With6Decimals",
      )
      const sixDecimals = await SixDecimals.deploy(
        "Six Decimals",
        "SIX",
        1_000_000n,
      )
      await sixDecimals.waitForDeployment()
      const sixDecimalsAddress = await sixDecimals.getAddress()

      const feeSlot = mappingEntrySlot(
        "address",
        fixture.tbtcAddress,
        PORTAL_FEE_INFO_SLOT,
      )
      await setStorageAt(
        fixture.portalAddress,
        feeSlot + 1n,
        BigInt(sixDecimalsAddress),
      )

      const misconfigured = await fixture.Recovery.deploy(
        fixture.portalAddress,
        fixture.proxyAdmin,
        await fixture.receiptPayer.getAddress(),
        await fixture.collateralRecipient.getAddress(),
        fixture.tbtcAddress,
        sixDecimalsAddress,
        RECOVERY_AMOUNT,
      )
      await misconfigured.waitForDeployment()

      await expect(
        scheduleRecovery(
          fixture,
          fixture.settlements,
          ethers.id("wrong-decimals-stbtc-recovery"),
          await misconfigured.getAddress(),
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "UnexpectedTokenDecimals",
      )
    })

    it("rejects zero configuration values in the constructor", async () => {
      const fixture = await loadFixture(deployFixture)

      await expect(
        fixture.Recovery.deploy(
          ethers.ZeroAddress,
          fixture.proxyAdmin,
          await fixture.receiptPayer.getAddress(),
          await fixture.collateralRecipient.getAddress(),
          fixture.tbtcAddress,
          fixture.stbtcAddress,
          RECOVERY_AMOUNT,
        ),
      ).to.be.revertedWithCustomError(
        fixture.Recovery,
        "ZeroConfigurationValue",
      )
    })
  })

  describe("deployed bytecode verification", () => {
    it("accepts an implementation compiled from this repository", async () => {
      const fixture = await loadFixture(deployFixture)

      const verification = await verifyRecoveryBytecode(
        ethers.provider,
        fixture.recoveryImplementation as string,
        await recoveryImmutableValues(fixture),
      )
      expect(verification.maskedImmutableRanges.length).to.be.greaterThan(0)
    })

    it("rejects a mismatched non-getter occurrence of an immutable", async () => {
      const fixture = await loadFixture(deployFixture)
      const expectedImmutables = await recoveryImmutableValues(fixture)
      const implementation = fixture.recoveryImplementation as string
      const verification = await verifyRecoveryBytecode(
        ethers.provider,
        implementation,
        expectedImmutables,
      )
      const originalCode = await ethers.provider.getCode(implementation)
      const maliciousRecipient = ethers.Wallet.createRandom().address
      const encodedRecipient = ethers.getBytes(
        abiCoder.encode(["address"], [maliciousRecipient]),
      )
      const configuredRecovery = fixture.Recovery.attach(implementation)
      const recipientRanges = verification.maskedImmutableRanges.filter(
        ({ name }) => name === "COLLATERAL_RECIPIENT",
      )

      // Solidity may emit several independent references for one immutable.
      // Find one not used by its public getter, mirroring custom initcode that
      // preserves the getter while redirecting the transfer path.
      const findBypassRange = async (
        index: number,
      ): Promise<
        { name: string; start: number; length: number } | undefined
      > => {
        if (index >= recipientRanges.length) {
          return undefined
        }
        const range = recipientRanges[index]
        const patchedCode = ethers.getBytes(originalCode)
        patchedCode.set(encodedRecipient, range.start)
        await network.provider.send("hardhat_setCode", [
          implementation,
          ethers.hexlify(patchedCode),
        ])
        if (
          (await configuredRecovery.COLLATERAL_RECIPIENT()) ===
          expectedImmutables.COLLATERAL_RECIPIENT
        ) {
          return range
        }
        await network.provider.send("hardhat_setCode", [
          implementation,
          originalCode,
        ])
        return findBypassRange(index + 1)
      }
      const bypassRange = await findBypassRange(0)

      expect(
        bypassRange,
        "expected a non-getter immutable occurrence",
      ).not.to.equal(undefined)

      let error: Error | undefined
      try {
        await verifyRecoveryBytecode(
          ethers.provider,
          implementation,
          expectedImmutables,
        )
      } catch (caught) {
        error = caught as Error
      }
      await network.provider.send("hardhat_setCode", [
        implementation,
        originalCode,
      ])

      expect(error?.message).to.match(
        /immutable COLLATERAL_RECIPIENT occurrence/,
      )
    })

    it("rejects a contract that is not the compiled artifact", async () => {
      const fixture = await loadFixture(deployFixture)

      let error: Error | undefined
      try {
        await verifyRecoveryBytecode(
          ethers.provider,
          fixture.portalAddress,
          await recoveryImmutableValues(fixture),
        )
      } catch (caught) {
        error = caught as Error
      }
      expect(error?.message).to.match(/bytecode length/)
    })
  })
})
