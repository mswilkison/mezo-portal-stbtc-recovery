import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"

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
    // Keep the fee at zero and configure a 100% historical mint cap.
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

  await stbtc.updateDebtAllowance(portalAddress, TOTAL_DEBT)
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

  const settlements = [
    {
      depositor: await depositor.getAddress(),
      depositId: 1n,
      amount: FIRST_DEBT,
    },
    {
      depositor: await depositor.getAddress(),
      depositId: 2n,
      amount: SECOND_SETTLEMENT,
    },
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
    portal,
    portalAddress,
    proxyAdmin,
    originalImplementation,
    tbtc,
    stbtc,
    tbtcAddress,
    timelock,
    Recovery,
    recoveryImplementation,
    proxyAdminInterface,
    settlements,
  }
}

async function scheduleRecovery(
  fixture: Awaited<ReturnType<typeof deployFixture>>,
  settlements: typeof fixture.settlements,
  salt: string,
) {
  const recoveryCall = fixture.Recovery.interface.encodeFunctionData(
    "recoverTbtc",
    [settlements],
  )
  const installAndRecover = fixture.proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [fixture.portalAddress, fixture.recoveryImplementation, recoveryCall],
  )
  const restorePortal = fixture.proxyAdminInterface.encodeFunctionData(
    "upgradeAndCall",
    [fixture.portalAddress, fixture.originalImplementation, "0x"],
  )

  const targets = [fixture.proxyAdmin, fixture.proxyAdmin]
  const values = [0, 0]
  const payloads = [installAndRecover, restorePortal]
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

describe("PortalStbtcRecovery", () => {
  it("settles stBTC for tBTC and restores Portal in one timelock batch", async () => {
    const fixture = await loadFixture(deployFixture)
    const recipient = await fixture.collateralRecipient.getAddress()
    const payer = await fixture.receiptPayer.getAddress()
    const depositor = await fixture.depositor.getAddress()

    const recoveryAtPortal = fixture.Recovery.attach(fixture.portalAddress)
    const transaction = scheduleRecovery(
      fixture,
      fixture.settlements,
      ethers.id("successful-stbtc-recovery"),
    )

    await expect(transaction)
      .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
      .withArgs(payer, recipient, RECOVERY_AMOUNT)

    expect(
      await upgrades.erc1967.getImplementationAddress(fixture.portalAddress),
    ).to.equal(fixture.originalImplementation)

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
    expect(secondDeposit.balance).to.equal(SECOND_BALANCE - SECOND_SETTLEMENT)
    expect(secondDeposit.receiptMinted).to.equal(
      SECOND_DEBT - SECOND_SETTLEMENT,
    )
    expect(fee.totalMinted).to.equal(TOTAL_DEBT - RECOVERY_AMOUNT)

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

  it("rolls back the upgrade and all state if the manifest total is wrong", async () => {
    const fixture = await loadFixture(deployFixture)
    const badSettlements = [
      fixture.settlements[0],
      {
        ...fixture.settlements[1],
        amount: SECOND_SETTLEMENT - 1n,
      },
    ]

    const transaction = scheduleRecovery(
      fixture,
      badSettlements,
      ethers.id("failed-stbtc-recovery"),
    )

    await expect(transaction).to.be.reverted

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
})
