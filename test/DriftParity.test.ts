import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import {
  SettlementProjectionInput,
  buildRecoveryBatchPayloads,
  projectSettlementOutcome,
} from "../helpers/recovery-preflight"

// The drift-tolerance policy exists twice: authoritatively in
// recoverTbtc, and mirrored in projectSettlementOutcome so the preflight can
// predict what governance is about to execute. Nothing but this file binds
// them. Each case below drives BOTH implementations from one scenario and
// asserts the projection equals what the contract actually settles, so an
// edit to either side alone fails here instead of surfacing as a preflight
// that promised an amount the batch did not deliver.

const PORTAL_DEPOSITS_SLOT = 0n
const PORTAL_FEE_INFO_SLOT = 5n
const PORTAL_TBTC_TOKEN_SLOT = 6n

const RECOVERY_MAX = ethers.parseEther("1")
const ANNUAL_FEE_PERCENT = 2n

const abiCoder = ethers.AbiCoder.defaultAbiCoder()

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
    ethers.toBeHex(slot, 32),
    ethers.toBeHex(value, 32),
  ])
}

type DepositSpec = {
  depositId: bigint
  balance: bigint
  receiptMinted: bigint
  migrating?: boolean
}

async function deployFixture() {
  const [governance, receiptPayer, collateralRecipient, depositor] =
    await ethers.getSigners()

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

  const Recovery = await ethers.getContractFactory("PortalStbtcRecovery")
  const recoveryImplementation = await upgrades.prepareUpgrade(
    portalAddress,
    Recovery,
    {
      kind: "transparent",
      constructorArgs: [
        portalAddress,
        proxyAdmin,
        await receiptPayer.getAddress(),
        await collateralRecipient.getAddress(),
        tbtcAddress,
        stbtcAddress,
        RECOVERY_MAX,
      ],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    },
  )

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
    tbtcAddress,
    stbtc,
    stbtcAddress,
    timelock,
    Recovery,
    recoveryImplementation,
  }
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>

// Writes one scenario into Portal storage, runs the batch, and returns both
// the amount the contract settled and the amount the mirror predicted.
async function runScenario(
  fixture: Fixture,
  spec: {
    deposits: DepositSpec[]
    settlements: { depositId: bigint; amount: bigint }[]
    depositorStbtc: bigint
    salt: string
  },
): Promise<{ actual: bigint; projected: bigint }> {
  const depositor = await fixture.depositor.getAddress()
  const payer = await fixture.receiptPayer.getAddress()
  const totalDebt = spec.deposits.reduce((t, d) => t + d.receiptMinted, 0n)

  // feeInfo: totalMinted + lastFeeUpdateAt(now) + annualFee + 100% mint cap.
  const latest = await ethers.provider.getBlock("latest")
  const feeSlot = mappingEntrySlot(
    "address",
    fixture.tbtcAddress,
    PORTAL_FEE_INFO_SLOT,
  )
  await setStorageAt(
    fixture.portalAddress,
    PORTAL_TBTC_TOKEN_SLOT,
    BigInt(fixture.tbtcAddress),
  )
  await setStorageAt(
    fixture.portalAddress,
    feeSlot,
    totalDebt +
      BigInt(latest!.timestamp) * 2n ** 96n +
      ANNUAL_FEE_PERCENT * 2n ** 216n +
      100n * 2n ** 224n,
  )
  await setStorageAt(
    fixture.portalAddress,
    feeSlot + 1n,
    BigInt(fixture.stbtcAddress),
  )

  let collateral = 0n
  // Sequential on purpose: hardhat_setStorageAt writes must land in order.
  // eslint-disable-next-line no-restricted-syntax
  for (const d of spec.deposits) {
    const base = depositStorageSlot(depositor, fixture.tbtcAddress, d.depositId)
    // eslint-disable-next-line no-await-in-loop
    await setStorageAt(
      fixture.portalAddress,
      base,
      d.balance + d.receiptMinted * 2n ** 128n,
    )
    // eslint-disable-next-line no-await-in-loop
    await setStorageAt(
      fixture.portalAddress,
      base + 1n,
      d.migrating ? 1n * 2n ** 184n : 0n,
    )
    collateral += d.balance
  }
  await fixture.tbtc.transfer(fixture.portalAddress, collateral)

  await fixture.stbtc.updateDebtAllowance(
    fixture.portalAddress,
    totalDebt + RECOVERY_MAX + spec.depositorStbtc,
  )
  await network.provider.send("hardhat_setBalance", [
    fixture.portalAddress,
    ethers.toBeHex(ethers.parseEther("1")),
  ])
  await network.provider.send("hardhat_impersonateAccount", [
    fixture.portalAddress,
  ])
  const portalSigner = await ethers.getSigner(fixture.portalAddress)
  await fixture.stbtc.connect(portalSigner).mintReceipt(payer, RECOVERY_MAX)
  if (spec.depositorStbtc > 0n) {
    await fixture.stbtc
      .connect(portalSigner)
      .mintReceipt(depositor, spec.depositorStbtc)
  }
  await network.provider.send("hardhat_stopImpersonatingAccount", [
    fixture.portalAddress,
  ])
  await fixture.stbtc
    .connect(fixture.receiptPayer)
    .approve(fixture.portalAddress, RECOVERY_MAX)

  const activeDepositIds = spec.deposits
    .map((d) => d.depositId)
    .sort((a, b) => {
      if (a === b) {
        return 0
      }
      return a < b ? -1 : 1
    })
  const settlements = spec.settlements.map((s) => ({
    depositor,
    depositId: s.depositId,
    amount: s.amount,
  }))
  const depositorContexts = [{ depositor, activeDepositIds }]

  // --- the mirror's prediction, from the same pre-execution state ---
  const liveDebt = spec.deposits
    .filter((d) => !d.migrating)
    .reduce((t, d) => t + d.receiptMinted, 0n)
  const capacity =
    liveDebt > spec.depositorStbtc ? liveDebt - spec.depositorStbtc : 0n
  const projectionInputs: SettlementProjectionInput[] = settlements.map((s) => {
    const d = spec.deposits.find((x) => x.depositId === s.depositId)
    return {
      depositor,
      depositId: s.depositId,
      amountWei: s.amount,
      deposit: {
        balanceWei: d ? d.balance : 0n,
        receiptMintedWei: d ? d.receiptMinted : 0n,
        migrating: d ? d.migrating === true : false,
        // The fixture's deposits are freshly seeded with feeOwed 0 and the
        // fee integral starting now, so accrual over the batch is zero.
        projectedFeeWei: 0n,
      },
    }
  })
  const { projectedTotalWei } = projectSettlementOutcome(
    projectionInputs,
    new Map([[depositor, capacity]]),
  )

  // --- the contract's actual behaviour ---
  const recoveryCall = fixture.Recovery.interface.encodeFunctionData(
    "recoverTbtc",
    [settlements, depositorContexts],
  )
  const { targets, values, payloads } = buildRecoveryBatchPayloads({
    portal: fixture.portalAddress,
    proxyAdmin: fixture.proxyAdmin,
    recoveryImplementation: fixture.recoveryImplementation as string,
    originalImplementation: fixture.originalImplementation,
    recoverCalldata: recoveryCall,
  })
  await fixture.timelock.scheduleBatch(
    targets,
    values,
    payloads,
    ethers.ZeroHash,
    spec.salt,
    0,
  )

  const recipient = await fixture.collateralRecipient.getAddress()
  const before = BigInt(await fixture.tbtc.balanceOf(recipient))
  await fixture.timelock.executeBatch(
    targets,
    values,
    payloads,
    ethers.ZeroHash,
    spec.salt,
  )
  const actual = BigInt(await fixture.tbtc.balanceOf(recipient)) - before

  return { actual, projected: projectedTotalWei }
}

describe("drift policy parity (contract vs preflight projection)", () => {
  it("agrees when everything settles in full", async () => {
    const fixture = await loadFixture(deployFixture)
    const { actual, projected } = await runScenario(fixture, {
      deposits: [
        {
          depositId: 1n,
          balance: ethers.parseEther("1.2"),
          receiptMinted: ethers.parseEther("0.7"),
        },
        {
          depositId: 2n,
          balance: ethers.parseEther("1"),
          receiptMinted: ethers.parseEther("0.6"),
        },
      ],
      settlements: [
        { depositId: 1n, amount: ethers.parseEther("0.7") },
        { depositId: 2n, amount: ethers.parseEther("0.3") },
      ],
      depositorStbtc: 0n,
      salt: ethers.id("parity-full"),
    })
    expect(actual).to.equal(ethers.parseEther("1"))
    expect(projected).to.equal(actual)
  })

  it("agrees when a deposit was partially repaid after review", async () => {
    const fixture = await loadFixture(deployFixture)
    const { actual, projected } = await runScenario(fixture, {
      deposits: [
        {
          depositId: 1n,
          balance: ethers.parseEther("1.2"),
          receiptMinted: ethers.parseEther("0.5"),
        },
        {
          depositId: 2n,
          balance: ethers.parseEther("1"),
          receiptMinted: ethers.parseEther("0.6"),
        },
      ],
      settlements: [
        { depositId: 1n, amount: ethers.parseEther("0.7") },
        { depositId: 2n, amount: ethers.parseEther("0.3") },
      ],
      depositorStbtc: 0n,
      salt: ethers.id("parity-clamped"),
    })
    expect(actual).to.equal(ethers.parseEther("0.8"))
    expect(projected).to.equal(actual)
  })

  it("agrees when the owner's holdings cap the round", async () => {
    const fixture = await loadFixture(deployFixture)
    const { actual, projected } = await runScenario(fixture, {
      deposits: [
        {
          depositId: 1n,
          balance: ethers.parseEther("1.2"),
          receiptMinted: ethers.parseEther("0.7"),
        },
        {
          depositId: 2n,
          balance: ethers.parseEther("1"),
          receiptMinted: ethers.parseEther("0.6"),
        },
      ],
      settlements: [
        { depositId: 1n, amount: ethers.parseEther("0.7") },
        { depositId: 2n, amount: ethers.parseEther("0.3") },
      ],
      // capacity = 1.3 - 0.4 = 0.9
      depositorStbtc: ethers.parseEther("0.4"),
      salt: ethers.id("parity-owner-capped"),
    })
    expect(actual).to.equal(ethers.parseEther("0.9"))
    expect(projected).to.equal(actual)
  })

  it("agrees when a deposit is skipped for migration", async () => {
    const fixture = await loadFixture(deployFixture)
    const { actual, projected } = await runScenario(fixture, {
      deposits: [
        {
          depositId: 1n,
          balance: ethers.parseEther("1.2"),
          receiptMinted: ethers.parseEther("0.7"),
        },
        {
          depositId: 2n,
          balance: ethers.parseEther("1"),
          receiptMinted: ethers.parseEther("0.6"),
          migrating: true,
        },
      ],
      settlements: [
        { depositId: 1n, amount: ethers.parseEther("0.7") },
        { depositId: 2n, amount: ethers.parseEther("0.3") },
      ],
      depositorStbtc: 0n,
      salt: ethers.id("parity-migrating"),
    })
    expect(actual).to.equal(ethers.parseEther("0.7"))
    expect(projected).to.equal(actual)
  })

  it("agrees when a deposit is skipped as under-collateralized", async () => {
    const fixture = await loadFixture(deployFixture)
    const { actual, projected } = await runScenario(fixture, {
      deposits: [
        {
          depositId: 1n,
          balance: ethers.parseEther("1.2"),
          receiptMinted: ethers.parseEther("0.7"),
        },
        // balance below debt: cannot settle without breaking collateral.
        {
          depositId: 2n,
          balance: ethers.parseEther("0.5"),
          receiptMinted: ethers.parseEther("0.6"),
        },
      ],
      settlements: [
        { depositId: 1n, amount: ethers.parseEther("0.7") },
        { depositId: 2n, amount: ethers.parseEther("0.3") },
      ],
      depositorStbtc: 0n,
      salt: ethers.id("parity-undercollateralized"),
    })
    expect(actual).to.equal(ethers.parseEther("0.7"))
    expect(projected).to.equal(actual)
  })
})
