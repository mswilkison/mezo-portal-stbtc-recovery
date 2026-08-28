import { readFileSync } from "fs"
import { artifacts, ethers } from "hardhat"
import {
  recoveryManifest as manifest,
  recoveryManifestPath,
} from "../helpers/recovery-manifest"
import {
  hasExactRecoveryAllowance,
  pinnedBlockContext,
  recomputeActiveReceiptDebt,
} from "../helpers/recovery-preflight"
import {
  RecoveryImmutableValues,
  verifyRecoveryBytecode,
} from "../helpers/verify-recovery-bytecode"

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const ONE_YEAR = 365n * 24n * 60n * 60n
const FEE_PRECISION = 10n ** 18n

const PROPOSER_ROLE = ethers.id("PROPOSER_ROLE")
const EXECUTOR_ROLE = ethers.id("EXECUTOR_ROLE")
const CANCELLER_ROLE = ethers.id("CANCELLER_ROLE")

// RECOVERY_STAGE=prepare (default) validates state and prints calldata while
// the Threshold approval is still expected to be outstanding.
// RECOVERY_STAGE=execute is the mandatory rerun immediately before
// `executeBatch`: it additionally requires the exact stBTC allowance to be in
// place and the scheduled timelock operation to be ready.
const STAGE = process.env.RECOVERY_STAGE ?? "prepare"

function fail(message: string): never {
  throw new Error(`Recovery preflight failed: ${message}`)
}

if (STAGE !== "prepare" && STAGE !== "execute") {
  fail(`unknown RECOVERY_STAGE "${STAGE}" (expected "prepare" or "execute")`)
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

function warn(message: string): void {
  // eslint-disable-next-line no-console
  console.error(`WARNING: ${message}`)
}

async function storageAt(
  address: string,
  slot: string,
  blockTag: string,
): Promise<string> {
  return ethers.provider.send("eth_getStorageAt", [address, slot, blockTag])
}

// The default operation salt commits to the exact manifest bytes, so every
// re-pinned manifest automatically produces a distinct timelock operation id
// and a stale, cancelled attempt can never collide with a corrected one.
// RECOVERY_SALT overrides it: a 32-byte hex string is used verbatim, any
// other value is hashed with ethers.id().
function operationSalt(manifestHash: string): {
  salt: string
  derivation: string
} {
  const raw = process.env.RECOVERY_SALT
  if (!raw) {
    return {
      salt: ethers.id(`threshold-stbtc-recovery:${manifestHash}`),
      derivation: `ethers.id("threshold-stbtc-recovery:<keccak256 of ${recoveryManifestPath}>")`,
    }
  }

  if (ethers.isHexString(raw, 32)) {
    return { salt: raw, derivation: "RECOVERY_SALT (32-byte hex, verbatim)" }
  }

  return {
    salt: ethers.id(raw),
    derivation: `ethers.id(RECOVERY_SALT="${raw}")`,
  }
}

async function main() {
  const network = await ethers.provider.getNetwork()
  expectEqual("chain ID", network.chainId, manifest.chainId)

  const requestedBlock = process.env.RECOVERY_BLOCK
    ? Number(process.env.RECOVERY_BLOCK)
    : undefined
  const block = await ethers.provider.getBlock(requestedBlock ?? "latest")
  if (!block) {
    fail(`block ${requestedBlock ?? "latest"} was not found`)
  }
  // Resolve `latest` exactly once. Every subsequent storage read, eth_call,
  // code read, fee calculation, and operation-state check is pinned to this
  // block so a slow preflight can never mix state from adjacent blocks.
  const { rpcBlockTag: blockTag, callOverrides } = pinnedBlockContext(
    block.number,
  )

  // Full EIP-55 checksum validation. The manifest must carry checksummed
  // addresses; a single corrupted character (collateralRecipient is the one
  // address no on-chain state anchors) must fail here, never be laundered
  // into valid-looking calldata.
  const addresses = Object.fromEntries(
    Object.entries(manifest.addresses).map(([key, value]) => {
      if (value !== ethers.getAddress(value)) {
        fail(
          `manifest address "${key}" (${value}) is not EIP-55 checksummed; ` +
            "refusing to guess — fix the manifest",
        )
      }
      return [key, value]
    }),
  ) as RecoveryManifestAddresses

  // Compile-time provenance: the Portal source reconstructed in this
  // repository must compile to exactly the runtime bytecode the proxy points
  // at. This is the review gate RECOVERY.md step 1 relies on.
  const portalArtifact = await artifacts.readArtifact("Portal")
  const compiledPortalHash = ethers.keccak256(portalArtifact.deployedBytecode)
  expectEqual(
    "compiled Portal runtime hash (run `npm run build`; requires evmVersion paris)",
    compiledPortalHash,
    manifest.implementationRuntimeHash,
  )

  const implementation = addressFromStorageWord(
    await storageAt(addresses.portal, IMPLEMENTATION_SLOT, blockTag),
  )
  const proxyAdmin = addressFromStorageWord(
    await storageAt(addresses.portal, ADMIN_SLOT, blockTag),
  )
  expectEqual(
    "Portal implementation (if a recovery batch is already scheduled, cancel it before resolving this)",
    implementation,
    addresses.originalImplementation,
  )
  expectEqual("Portal ProxyAdmin", proxyAdmin, addresses.proxyAdmin)

  const implementationCode = await ethers.provider.getCode(
    implementation,
    block.number,
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
      "function getTimestamp(bytes32) view returns (uint256)",
      "function hasRole(bytes32,address) view returns (bool)",
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
    senderHasProposerRole,
    senderHasExecutorRole,
    senderHasCancellerRole,
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
    timelock.hasRole(PROPOSER_ROLE, addresses.portalLogicOwner, callOverrides),
    timelock.hasRole(EXECUTOR_ROLE, addresses.portalLogicOwner, callOverrides),
    timelock.hasRole(CANCELLER_ROLE, addresses.portalLogicOwner, callOverrides),
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

  // The intended governance sender must actually hold the timelock roles the
  // runbook has it use. Roles are as rotatable as ProxyAdmin ownership, which
  // this preflight already re-verifies on every run.
  if (STAGE === "prepare" && !senderHasProposerRole) {
    fail(
      `${addresses.portalLogicOwner} does not hold PROPOSER_ROLE on the ` +
        "timelock; scheduleBatch would revert",
    )
  }
  if (STAGE === "execute" && !senderHasExecutorRole) {
    fail(
      `${addresses.portalLogicOwner} does not hold EXECUTOR_ROLE on the ` +
        "timelock; executeBatch would revert",
    )
  }
  if (!senderHasExecutorRole) {
    warn(
      `${addresses.portalLogicOwner} does not hold EXECUTOR_ROLE on the timelock`,
    )
  }
  if (!senderHasCancellerRole) {
    warn(
      `${addresses.portalLogicOwner} does not hold CANCELLER_ROLE on the ` +
        "timelock; the documented cancel-on-drift/abort path needs a canceller",
    )
  }

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

  // Threshold's one on-chain action. In the execute-stage rerun this is a
  // hard requirement — a green preflight must guarantee executeBatch cannot
  // revert inside safeTransferFrom.
  if (
    !hasExactRecoveryAllowance(BigInt(receiptPayerAllowance), recoveryAmount)
  ) {
    const message =
      "receipt payer allowance to the Portal proxy is " +
      `${receiptPayerAllowance.toString()} but must equal exactly ` +
      `${recoveryAmount.toString()}; Threshold must approve the Portal ` +
      `proxy (${addresses.portal}) — not the recovery implementation — ` +
      "for exactly the recovery amount"
    if (STAGE === "execute") {
      fail(message)
    }
    warn(`${message} (expected while preparing; required before execution)`)
  }

  const annualFeeRate = (BigInt(fee.annualFee) * 10n ** 16n) / ONE_YEAR
  const effectiveFeeIntegral =
    BigInt(fee.feeIntegral) +
    (BigInt(block.timestamp) - BigInt(fee.lastFeeUpdateAt)) * annualFeeRate

  const checkedSettlements = await Promise.all(
    manifest.settlements.map(async (settlement) => {
      const depositorAddress = ethers.getAddress(settlement.depositor)
      const deposit = await portal.deposits(
        depositorAddress,
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
        depositor: depositorAddress,
        depositId: BigInt(settlement.depositId),
        amount,
        depositorActiveDebtWei: settlement.depositorActiveDebtWei,
        depositorActiveDepositIds: settlement.depositorActiveDepositIds,
        currentBalanceWei: BigInt(deposit.balance),
        currentDebtWei: BigInt(deposit.receiptMinted),
        projectedFeeWei: projectedFee,
        collateralMarginWei: collateralMargin,
      }
    }),
  )

  // Stranding check: settling a deposit burns down debt the depositor could
  // otherwise repay themselves. A depositor left holding more stBTC than
  // their remaining receipt debt has no repayment path for the excess — the
  // exact condition this recovery exists to cure for Threshold must not be
  // recreated for a third party. The manifest supplies the complete set of
  // deposit ids that were active for each selected owner at the snapshot, but
  // their debt is read again at this preflight's pinned block. A newly active
  // id omitted from the snapshot can only make this recomputation conservative.
  const byDepositor = new Map<
    string,
    {
      settled: bigint
      manifestActiveDebt: bigint
      activeDepositIds: string[]
    }
  >()
  checkedSettlements.forEach((settlement) => {
    const activeDepositIds = settlement.depositorActiveDepositIds
    if (!activeDepositIds.includes(settlement.depositId.toString())) {
      fail(
        `active deposit ids for ${settlement.depositor} do not include ` +
          `selected deposit ${settlement.depositId.toString()}`,
      )
    }

    const manifestActiveDebt = BigInt(settlement.depositorActiveDebtWei)
    const existing = byDepositor.get(settlement.depositor)
    if (
      existing &&
      (existing.manifestActiveDebt !== manifestActiveDebt ||
        existing.activeDepositIds.join(",") !== activeDepositIds.join(","))
    ) {
      fail(
        `inconsistent active-debt metadata for ${settlement.depositor} ` +
          "across settlement entries",
      )
    }

    const entry = existing ?? {
      settled: 0n,
      manifestActiveDebt,
      activeDepositIds,
    }
    entry.settled += settlement.amount
    byDepositor.set(settlement.depositor, entry)
  })

  const strandingCheck = await Promise.all(
    Array.from(byDepositor.entries()).map(async ([depositor, entry]) => {
      const { depositIds, totalDebt: debtBefore } =
        await recomputeActiveReceiptDebt(
          entry.activeDepositIds,
          async (depositId) =>
            BigInt(
              (
                await portal.deposits(
                  depositor,
                  addresses.tbtc,
                  depositId,
                  callOverrides,
                )
              ).receiptMinted,
            ),
        )
      if (block.number === manifest.snapshotBlock) {
        expectEqual(
          `depositor ${depositor} active debt at snapshot`,
          debtBefore,
          entry.manifestActiveDebt,
        )
      }
      if (entry.settled > debtBefore) {
        fail(
          `settlements for ${depositor} exceed live active debt ` +
            `(${entry.settled.toString()} > ${debtBefore.toString()})`,
        )
      }

      const stbtcBalance = BigInt(
        await stbtc.balanceOf(depositor, callOverrides),
      )
      const debtAfter = debtBefore - entry.settled
      return {
        depositor,
        activeDepositIds: depositIds,
        stbtcBalanceWei: stbtcBalance,
        manifestReceiptDebtWei: entry.manifestActiveDebt,
        receiptDebtBeforeWei: debtBefore,
        receiptDebtAfterWei: debtAfter,
        strandedExcessWei:
          stbtcBalance > debtAfter ? stbtcBalance - debtAfter : 0n,
      }
    }),
  )

  const strandedDepositors = strandingCheck.filter(
    (entry) => entry.strandedExcessWei > 0n,
  )
  if (strandedDepositors.length > 0) {
    const details = strandedDepositors
      .map(
        (entry) =>
          `${entry.depositor} holds ${entry.stbtcBalanceWei.toString()} stBTC ` +
          `but would retain only ${entry.receiptDebtAfterWei.toString()} ` +
          `receipt debt (${entry.strandedExcessWei.toString()} unredeemable)`,
      )
      .join("; ")
    if (process.env.RECOVERY_ACKNOWLEDGE_STRANDING === "1") {
      warn(
        `stranding acknowledged by RECOVERY_ACKNOWLEDGE_STRANDING: ${details}`,
      )
    } else {
      fail(
        `settlement would strand third-party stBTC holders: ${details}. ` +
          "Regenerate the manifest with a balance-aware selection " +
          "(scripts/generate-stbtc-recovery-manifest.ts) or, if governance " +
          "explicitly accepts this, set RECOVERY_ACKNOWLEDGE_STRANDING=1",
      )
    }
  }

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
  const expectedRecoveryImmutables: RecoveryImmutableValues = {
    EXPECTED_PORTAL: addresses.portal,
    RECOVERY_AUTHORITY: addresses.proxyAdmin,
    RECEIPT_PAYER: addresses.receiptPayer,
    COLLATERAL_RECIPIENT: addresses.collateralRecipient,
    EXPECTED_TBTC: addresses.tbtc,
    EXPECTED_RECEIPT_TOKEN: addresses.stbtc,
    EXPECTED_RECOVERY_AMOUNT: recoveryAmount,
  }
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

  const manifestHash = ethers.keccak256(readFileSync(recoveryManifestPath))

  const output: Record<string, unknown> = {
    stage: STAGE,
    verifiedAt: {
      blockNumber: block.number,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
    },
    provenance: {
      manifestPath: recoveryManifestPath,
      manifestHash,
      compiledPortalRuntimeHash: compiledPortalHash,
    },
    state: {
      implementation,
      implementationRuntimeHash: ethers.keccak256(implementationCode),
      proxyAdmin,
      proxyAdminOwner,
      timelockRoles: {
        account: addresses.portalLogicOwner,
        proposer: senderHasProposerRole,
        executor: senderHasExecutorRole,
        canceller: senderHasCancellerRole,
      },
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
    strandingCheck,
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
  if (STAGE === "execute" && !recoveryImplementation) {
    fail("RECOVERY_STAGE=execute requires RECOVERY_IMPLEMENTATION")
  }
  if (recoveryImplementation) {
    const recoveryAddress = ethers.getAddress(recoveryImplementation)
    const recoveryCode = await ethers.provider.getCode(
      recoveryAddress,
      block.number,
    )
    if (recoveryCode === "0x") {
      fail(`no code at RECOVERY_IMPLEMENTATION ${recoveryAddress}`)
    }

    // The deployed implementation must be byte-for-byte the compiled local
    // artifact. Every immutable occurrence is checked against its expected
    // constructor value before the ranges are masked for the remaining-code
    // comparison; checking only the seven getters is insufficient because
    // custom initcode can patch separate occurrences differently.
    const bytecodeVerification = await verifyRecoveryBytecode(
      ethers.provider,
      recoveryAddress,
      expectedRecoveryImmutables,
      block.number,
    )

    const configuredRecovery = new ethers.Contract(
      recoveryAddress,
      recoveryFactory.interface,
      ethers.provider,
    )
    const immutableValues = await Promise.all([
      configuredRecovery.EXPECTED_PORTAL(callOverrides),
      configuredRecovery.RECOVERY_AUTHORITY(callOverrides),
      configuredRecovery.RECEIPT_PAYER(callOverrides),
      configuredRecovery.COLLATERAL_RECIPIENT(callOverrides),
      configuredRecovery.EXPECTED_TBTC(callOverrides),
      configuredRecovery.EXPECTED_RECEIPT_TOKEN(callOverrides),
      configuredRecovery.EXPECTED_RECOVERY_AMOUNT(callOverrides),
    ])
    constructorArgs.forEach((expected, index) =>
      expectEqual(
        `recovery immutable ${index}`,
        immutableValues[index],
        expected,
      ),
    )

    const misdirectedAllowance = BigInt(
      await stbtc.allowance(
        addresses.receiptPayer,
        recoveryAddress,
        callOverrides,
      ),
    )
    if (misdirectedAllowance > 0n) {
      warn(
        "receipt payer approved the recovery implementation " +
          `(${recoveryAddress}) for ${misdirectedAllowance.toString()}; ` +
          "that allowance is unusable — the approval must go to the Portal " +
          `proxy (${addresses.portal}) and this one should be revoked`,
      )
    }

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
    const { salt, derivation } = operationSalt(manifestHash)
    const operationId = await timelock.hashOperationBatch(
      targets,
      values,
      payloads,
      predecessor,
      salt,
      callOverrides,
    )

    // Surface the operation's lifecycle state so stale or duplicate
    // operations are caught before any transaction is signed. Timelock
    // operations never expire on their own.
    const operationTimestamp = BigInt(
      await timelock.getTimestamp(operationId, callOverrides),
    )
    let operationState: string
    if (operationTimestamp === 0n) {
      operationState = "unset"
    } else if (operationTimestamp === 1n) {
      operationState = "done"
    } else if (operationTimestamp <= BigInt(block.timestamp)) {
      operationState = "ready"
    } else {
      operationState = "waiting"
    }

    if (STAGE === "execute" && operationState !== "ready") {
      fail(
        `timelock operation ${operationId} is "${operationState}" ` +
          `(timestamp ${operationTimestamp.toString()}); executeBatch ` +
          "requires it to be ready",
      )
    }
    if (STAGE === "prepare" && operationState !== "unset") {
      warn(
        `timelock operation ${operationId} already exists ` +
          `(state: ${operationState}). Re-scheduling the same batch and salt ` +
          "would revert; cancel the existing operation or use a new salt",
      )
    }

    const timelockInterface = new ethers.Interface([
      "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
      "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
      "function cancel(bytes32 id)",
    ])

    output.governanceBatch = {
      recoveryImplementation: recoveryAddress,
      recoveryImplementationRuntimeHash:
        bytecodeVerification.deployedRuntimeHash,
      recoveryArtifactRuntimeHash: bytecodeVerification.artifactRuntimeHash,
      bytecodeVerified: true,
      operationId,
      operationState,
      operationTimestamp,
      targets,
      values,
      payloads,
      predecessor,
      salt,
      saltDerivation: derivation,
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
      cancelTransaction: {
        target: addresses.proxyAdminOwnerTimelock,
        value: "0",
        calldata: timelockInterface.encodeFunctionData("cancel", [operationId]),
      },
    }
  }

  // eslint-disable-next-line no-console
  console.log(stringify(output))
}

type RecoveryManifestAddresses = (typeof manifest)["addresses"]

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
