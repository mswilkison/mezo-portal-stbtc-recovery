import { readFileSync } from "fs"
import { join } from "path"
import { ethers } from "hardhat"

type ManifestSettlement = {
  depositor: string
  depositId: string
  amountWei: string
  preState: {
    balanceWei: string
    receiptDebtWei: string
    feeOwedWei: string
    lastFeeIntegral: string
    migrationState: number
    feeAtSnapshotWei: string
    collateralMarginAtSnapshotWei: string
  }
}

type RecoveryManifest = {
  chainId: number
  snapshotBlock: number
  implementationRuntimeHash: string
  recoveryAmountWei: string
  addresses: {
    portal: string
    originalImplementation: string
    proxyAdmin: string
    proxyAdminOwnerTimelock: string
    tbtc: string
    stbtc: string
    receiptPayer: string
    collateralRecipient: string
  }
  settlements: ManifestSettlement[]
}

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const ONE_YEAR = 365n * 24n * 60n * 60n
const FEE_PRECISION = 10n ** 18n

const manifestPath = join(__dirname, "..", "recovery", "mainnet-25849540.json")
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as RecoveryManifest

function fail(message: string): never {
  throw new Error(`Recovery preflight failed: ${message}`)
}

function expectEqual(
  label: string,
  actual: bigint | number | string,
  expected: bigint | number | string,
): void {
  if (actual.toString().toLowerCase() !== expected.toString().toLowerCase()) {
    fail(`${label}: expected ${expected.toString()}, got ${actual.toString()}`)
  }
}

function addressFromStorageWord(word: string): string {
  return ethers.getAddress(`0x${word.slice(-40)}`)
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  )
}

async function storageAt(
  address: string,
  slot: string,
  blockTag: string,
): Promise<string> {
  return ethers.provider.send("eth_getStorageAt", [address, slot, blockTag])
}

async function main() {
  const network = await ethers.provider.getNetwork()
  expectEqual("chain ID", network.chainId, manifest.chainId)

  const requestedBlock = process.env.RECOVERY_BLOCK
    ? Number(process.env.RECOVERY_BLOCK)
    : undefined
  const blockTag = requestedBlock ? ethers.toQuantity(requestedBlock) : "latest"
  const block = await ethers.provider.getBlock(requestedBlock ?? "latest")
  if (!block) {
    fail(`block ${requestedBlock ?? "latest"} was not found`)
  }

  const addresses = Object.fromEntries(
    Object.entries(manifest.addresses).map(([key, value]) => [
      key,
      ethers.getAddress(value.toLowerCase()),
    ]),
  ) as RecoveryManifest["addresses"]

  const implementation = addressFromStorageWord(
    await storageAt(addresses.portal, IMPLEMENTATION_SLOT, blockTag),
  )
  const proxyAdmin = addressFromStorageWord(
    await storageAt(addresses.portal, ADMIN_SLOT, blockTag),
  )
  expectEqual(
    "Portal implementation",
    implementation,
    addresses.originalImplementation,
  )
  expectEqual("Portal ProxyAdmin", proxyAdmin, addresses.proxyAdmin)

  const implementationCode = await ethers.provider.getCode(
    implementation,
    requestedBlock ?? "latest",
  )
  expectEqual(
    "Portal implementation runtime hash",
    ethers.keccak256(implementationCode),
    manifest.implementationRuntimeHash,
  )

  const portal = new ethers.Contract(
    addresses.portal,
    [
      "function tbtcToken() view returns (address)",
      "function feeInfo(address) view returns (uint96 totalMinted,uint32 lastFeeUpdateAt,uint88 feeIntegral,uint8 annualFee,uint8 mintCap,address receiptToken,uint96 feeCollected)",
      "function deposits(address,address,uint256) view returns (uint96 balance,uint32 unlockAt,uint96 receiptMinted,uint96 feeOwed,uint88 lastFeeIntegral,uint8 tbtcMigrationState,bool autoBridgingOptOut)",
    ],
    ethers.provider,
  )
  const proxyAdminContract = new ethers.Contract(
    addresses.proxyAdmin,
    ["function owner() view returns (address)"],
    ethers.provider,
  )
  const timelock = new ethers.Contract(
    addresses.proxyAdminOwnerTimelock,
    [
      "function getMinDelay() view returns (uint256)",
      "function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns (bytes32)",
    ],
    ethers.provider,
  )
  const tbtc = new ethers.Contract(
    addresses.tbtc,
    [
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  )
  const stbtc = new ethers.Contract(
    addresses.stbtc,
    [
      "function balanceOf(address) view returns (uint256)",
      "function allowance(address,address) view returns (uint256)",
      "function currentDebt(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ],
    ethers.provider,
  )

  const callOverrides = { blockTag: requestedBlock ?? "latest" }
  const [
    configuredTbtc,
    fee,
    proxyAdminOwner,
    portalTbtcBalance,
    receiptPayerBalance,
    receiptPayerAllowance,
    portalStbtcDebt,
    tbtcDecimals,
    stbtcDecimals,
    minimumDelay,
  ] = await Promise.all([
    portal.tbtcToken(callOverrides),
    portal.feeInfo(addresses.tbtc, callOverrides),
    proxyAdminContract.owner(callOverrides),
    tbtc.balanceOf(addresses.portal, callOverrides),
    stbtc.balanceOf(addresses.receiptPayer, callOverrides),
    stbtc.allowance(addresses.receiptPayer, addresses.portal, callOverrides),
    stbtc.currentDebt(addresses.portal, callOverrides),
    tbtc.decimals(callOverrides),
    stbtc.decimals(callOverrides),
    timelock.getMinDelay(callOverrides),
  ])

  expectEqual("configured tBTC", configuredTbtc, addresses.tbtc)
  expectEqual("configured receipt token", fee.receiptToken, addresses.stbtc)
  expectEqual(
    "ProxyAdmin owner",
    proxyAdminOwner,
    addresses.proxyAdminOwnerTimelock,
  )
  expectEqual("tBTC decimals", tbtcDecimals, 18)
  expectEqual("stBTC decimals", stbtcDecimals, 18)

  const recoveryAmount = BigInt(manifest.recoveryAmountWei)
  const manifestTotal = manifest.settlements.reduce(
    (total, settlement) => total + BigInt(settlement.amountWei),
    0n,
  )
  expectEqual("manifest settlement total", manifestTotal, recoveryAmount)

  if (BigInt(portalTbtcBalance) < recoveryAmount) {
    fail("Portal does not hold enough tBTC")
  }
  if (BigInt(receiptPayerBalance) < recoveryAmount) {
    fail("receipt payer does not hold the configured stBTC amount")
  }
  if (BigInt(portalStbtcDebt) < recoveryAmount) {
    fail("Portal does not have enough stBTC debt to burn the recovery amount")
  }
  if (BigInt(fee.totalMinted) < recoveryAmount) {
    fail("Portal does not have enough tBTC-specific receipt debt")
  }

  const annualFeeRate = (BigInt(fee.annualFee) * 10n ** 16n) / ONE_YEAR
  const effectiveFeeIntegral =
    BigInt(fee.feeIntegral) +
    (BigInt(block.timestamp) - BigInt(fee.lastFeeUpdateAt)) * annualFeeRate

  const checkedSettlements = await Promise.all(
    manifest.settlements.map(async (settlement) => {
      const deposit = await portal.deposits(
        settlement.depositor,
        addresses.tbtc,
        settlement.depositId,
        callOverrides,
      )

      expectEqual(
        `deposit ${settlement.depositor}/${settlement.depositId} balance`,
        deposit.balance,
        settlement.preState.balanceWei,
      )
      expectEqual(
        `deposit ${settlement.depositor}/${settlement.depositId} debt`,
        deposit.receiptMinted,
        settlement.preState.receiptDebtWei,
      )
      expectEqual(
        `deposit ${settlement.depositor}/${settlement.depositId} fee owed`,
        deposit.feeOwed,
        settlement.preState.feeOwedWei,
      )
      expectEqual(
        `deposit ${settlement.depositor}/${settlement.depositId} fee integral`,
        deposit.lastFeeIntegral,
        settlement.preState.lastFeeIntegral,
      )
      expectEqual(
        `deposit ${settlement.depositor}/${settlement.depositId} migration state`,
        deposit.tbtcMigrationState,
        settlement.preState.migrationState,
      )

      const amount = BigInt(settlement.amountWei)
      if (amount === 0n || amount > BigInt(deposit.receiptMinted)) {
        fail(
          `invalid amount for deposit ${settlement.depositor}/${settlement.depositId}`,
        )
      }

      const projectedFee =
        BigInt(deposit.feeOwed) +
        ((effectiveFeeIntegral - BigInt(deposit.lastFeeIntegral)) *
          BigInt(deposit.receiptMinted)) /
          FEE_PRECISION
      const collateralMargin =
        BigInt(deposit.balance) - BigInt(deposit.receiptMinted) - projectedFee
      if (collateralMargin < 0n) {
        fail(
          `deposit ${settlement.depositor}/${settlement.depositId} is undercollateralized`,
        )
      }

      if (block.number === manifest.snapshotBlock) {
        expectEqual(
          `deposit ${settlement.depositor}/${settlement.depositId} snapshot fee`,
          projectedFee,
          settlement.preState.feeAtSnapshotWei,
        )
        expectEqual(
          `deposit ${settlement.depositor}/${settlement.depositId} snapshot margin`,
          collateralMargin,
          settlement.preState.collateralMarginAtSnapshotWei,
        )
      }

      return {
        depositor: ethers.getAddress(settlement.depositor),
        depositId: BigInt(settlement.depositId),
        amount,
        currentBalanceWei: BigInt(deposit.balance),
        currentDebtWei: BigInt(deposit.receiptMinted),
        projectedFeeWei: projectedFee,
        collateralMarginWei: collateralMargin,
      }
    }),
  )

  const recoveryFactory = await ethers.getContractFactory("PortalStbtcRecovery")
  const constructorArgs = [
    addresses.portal,
    addresses.proxyAdmin,
    addresses.receiptPayer,
    addresses.collateralRecipient,
    addresses.tbtc,
    addresses.stbtc,
    recoveryAmount,
  ] as const
  const recoveryCall = recoveryFactory.interface.encodeFunctionData(
    "recoverTbtc",
    [
      checkedSettlements.map(({ depositor, depositId, amount }) => ({
        depositor,
        depositId,
        amount,
      })),
    ],
  )
  const approvalCall = new ethers.Interface([
    "function approve(address spender,uint256 amount) returns (bool)",
  ]).encodeFunctionData("approve", [addresses.portal, recoveryAmount])

  const output: Record<string, unknown> = {
    verifiedAt: {
      blockNumber: block.number,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
    },
    state: {
      implementation,
      implementationRuntimeHash: ethers.keccak256(implementationCode),
      proxyAdmin,
      proxyAdminOwner,
      portalTbtcBalanceWei: portalTbtcBalance,
      portalStbtcDebtWei: portalStbtcDebt,
      tbtcReceiptDebtWei: fee.totalMinted,
      feeLastUpdateAt: fee.lastFeeUpdateAt,
      storedFeeIntegral: fee.feeIntegral,
      annualFeePercent: fee.annualFee,
      effectiveFeeIntegral,
      receiptPayerStbtcBalanceWei: receiptPayerBalance,
      receiptPayerAllowanceWei: receiptPayerAllowance,
    },
    receiptPayerApproval: {
      from: addresses.receiptPayer,
      target: addresses.stbtc,
      value: "0",
      calldata: approvalCall,
    },
    recoveryDeployment: {
      contract: "contracts/PortalStbtcRecovery.sol:PortalStbtcRecovery",
      constructorArgs,
    },
    recoverTbtcCalldata: recoveryCall,
    settlements: checkedSettlements,
  }

  const recoveryImplementation = process.env.RECOVERY_IMPLEMENTATION
  if (recoveryImplementation) {
    const recoveryAddress = ethers.getAddress(recoveryImplementation)
    const recoveryCode = await ethers.provider.getCode(recoveryAddress)
    if (recoveryCode === "0x") {
      fail(`no code at RECOVERY_IMPLEMENTATION ${recoveryAddress}`)
    }

    const configuredRecovery = recoveryFactory.attach(recoveryAddress)
    const immutableValues = await Promise.all([
      configuredRecovery.EXPECTED_PORTAL(),
      configuredRecovery.RECOVERY_AUTHORITY(),
      configuredRecovery.RECEIPT_PAYER(),
      configuredRecovery.COLLATERAL_RECIPIENT(),
      configuredRecovery.EXPECTED_TBTC(),
      configuredRecovery.EXPECTED_RECEIPT_TOKEN(),
      configuredRecovery.EXPECTED_RECOVERY_AMOUNT(),
    ])
    constructorArgs.forEach((expected, index) =>
      expectEqual(
        `recovery immutable ${index}`,
        immutableValues[index],
        expected,
      ),
    )

    const proxyAdminInterface = new ethers.Interface([
      "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
    ])
    const installAndRecover = proxyAdminInterface.encodeFunctionData(
      "upgradeAndCall",
      [addresses.portal, recoveryAddress, recoveryCall],
    )
    const restorePortal = proxyAdminInterface.encodeFunctionData(
      "upgradeAndCall",
      [addresses.portal, addresses.originalImplementation, "0x"],
    )
    const targets = [addresses.proxyAdmin, addresses.proxyAdmin]
    const values = [0n, 0n]
    const payloads = [installAndRecover, restorePortal]
    const predecessor = ethers.ZeroHash
    const salt = process.env.RECOVERY_SALT
      ? ethers.hexlify(process.env.RECOVERY_SALT)
      : ethers.id("threshold-stbtc-recovery-v1")
    const operationId = await timelock.hashOperationBatch(
      targets,
      values,
      payloads,
      predecessor,
      salt,
    )
    const timelockInterface = new ethers.Interface([
      "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
      "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
    ])

    output.governanceBatch = {
      recoveryImplementation: recoveryAddress,
      recoveryImplementationRuntimeHash: ethers.keccak256(recoveryCode),
      operationId,
      targets,
      values,
      payloads,
      predecessor,
      salt,
      minimumDelay,
      scheduleTransaction: {
        target: addresses.proxyAdminOwnerTimelock,
        value: "0",
        calldata: timelockInterface.encodeFunctionData("scheduleBatch", [
          targets,
          values,
          payloads,
          predecessor,
          salt,
          minimumDelay,
        ]),
      },
      executeTransaction: {
        target: addresses.proxyAdminOwnerTimelock,
        value: "0",
        calldata: timelockInterface.encodeFunctionData("executeBatch", [
          targets,
          values,
          payloads,
          predecessor,
          salt,
        ]),
      },
    }
  }

  // eslint-disable-next-line no-console
  console.log(stringify(output))
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
