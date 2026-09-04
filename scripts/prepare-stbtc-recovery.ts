import { readFileSync } from "fs"
import type { Block } from "ethers"
import { artifacts, ethers } from "hardhat"
import {
  ExternalStbtcScreenReport,
  createEthersExternalStbtcReader,
  createExternalStbtcLogHistory,
  evaluateExternalStbtcGate,
  getLogsInChunks,
  screenExternalStbtcHoldings,
  verifyPortalSinkIdentity,
} from "../helpers/external-stbtc"
import * as anchors from "../helpers/recovery-anchors"
import {
  assertManifestSnapshotCanonical,
  loadRecoveryManifest,
  recoveryManifestPath,
} from "../helpers/recovery-manifest"
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  MAX_CONVERGENCE_HEAD_LAG_BLOCKS,
  MAX_EXECUTE_HEAD_LAG_BLOCKS,
  SettlementProjectionInput,
  assertExactActiveDepositIds,
  assertPinnedBlockHashUnchanged,
  assertStillLatestBlock,
  buildRecoveryBatchPayloads,
  emitRecoveryPreflightResult,
  evaluateAtConvergedLatest,
  effectiveFeeIntegralAt,
  exceedsRecoveryReductionTolerance,
  hasExactRecoveryAllowance,
  maximumSettlementFromLiveDebt,
  pinnedBlockContext,
  projectSettlementOutcome,
  projectedFeeOwed,
  readLiveSettlementOwners,
  recomputeActiveReceiptDebt,
} from "../helpers/recovery-preflight"
import {
  RecoveryBytecodeVerification,
  RecoveryImmutableValues,
  verifyRecoveryBytecode,
} from "../helpers/verify-recovery-bytecode"

const manifest = loadRecoveryManifest()

const PROPOSER_ROLE = ethers.id("PROPOSER_ROLE")
const EXECUTOR_ROLE = ethers.id("EXECUTOR_ROLE")
const CANCELLER_ROLE = ethers.id("CANCELLER_ROLE")
const RECEIPT_MINTED_TOPIC = ethers.id(
  "ReceiptMinted(address,address,uint256,uint256)",
)

// Fee accrual between the preflight block and the executeBatch transaction;
// used only to pad the projection's under-collateralization classification
// toward the safe side.
const FEE_DRIFT_PAD_SECONDS = 3600n

// RECOVERY_STAGE=prepare (default) validates the manifest against a chosen
// block (RECOVERY_BLOCK or latest) and prints calldata while the Threshold
// approval is still expected to be outstanding. Selected-deposit state must
// match the manifest exactly at the snapshot block; at other blocks drift is
// reported and the clamped execution outcome is projected instead, because
// the contract tolerates drift by design — a hard failure here would hand
// third parties a process-level veto the contract itself does not have.
// RECOVERY_STAGE=execute is the mandatory rerun immediately before
// `executeBatch`: it always runs against latest state and additionally
// requires the exact stBTC allowance, an unpaused stBTC, a ready timelock
// operation, a nonzero projected settlement, and the latest-state
// external-holdings screen plus its explicit manual review confirmation.
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

function appendDeferredFailure(
  current: string | undefined,
  next: string,
): string {
  return current ? `${current}; additionally, ${next}` : next
}

async function storageAt(
  address: string,
  slot: string,
  blockTag: { blockHash: string; requireCanonical: true },
): Promise<string> {
  return ethers.provider.send("eth_getStorageAt", [address, slot, blockTag])
}

// The default operation salt commits to the manifest's JSON content, so every
// re-pinned manifest automatically produces a distinct timelock operation id
// and a stale, cancelled attempt can never collide with a corrected one. It
// deliberately does NOT commit to the file's exact bytes: a prettier reflow
// or line-ending change between scheduling and the execute-stage rerun must
// not move the operation id away from the scheduled one, or the rerun would
// report an unrelated id as "unset" and print cancel calldata for an
// operation that was never scheduled. RECOVERY_SALT overrides it: a 32-byte
// hex string is used verbatim, any other value is hashed with ethers.id().
function operationSalt(manifestContentHash: string): {
  salt: string
  derivation: string
} {
  const raw = process.env.RECOVERY_SALT
  if (!raw) {
    return {
      salt: ethers.id(`threshold-stbtc-recovery:${manifestContentHash}`),
      derivation:
        'ethers.id("threshold-stbtc-recovery:<keccak256 of the canonical ' +
        `(whitespace-insensitive) JSON content of ${recoveryManifestPath}>")`,
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
  await assertManifestSnapshotCanonical(ethers.provider, manifest)

  const requestedBlock = process.env.RECOVERY_BLOCK
    ? Number(process.env.RECOVERY_BLOCK)
    : undefined
  // A historical block would make every "green means executeBatch cannot
  // revert" guarantee meaningless, so the execute stage refuses one.
  if (STAGE === "execute" && requestedBlock !== undefined) {
    fail(
      "RECOVERY_STAGE=execute must validate latest state; unset RECOVERY_BLOCK",
    )
  }
  // The execute stage cannot build the governance batch, verify the deployed
  // implementation, or derive the timelock operation id without the deployed
  // recovery address, so demand it before the deployment-to-head archive
  // scan rather than after it (that scan is minutes on a capped provider).
  const recoveryImplementationInput = process.env.RECOVERY_IMPLEMENTATION
  if (STAGE === "execute" && !recoveryImplementationInput) {
    fail("RECOVERY_STAGE=execute requires RECOVERY_IMPLEMENTATION")
  }
  let recoveryImplementation: string | undefined
  if (recoveryImplementationInput) {
    try {
      recoveryImplementation = ethers.getAddress(recoveryImplementationInput)
    } catch {
      fail(
        `RECOVERY_IMPLEMENTATION "${recoveryImplementationInput}" is not a ` +
          "valid address",
      )
    }
  }
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

  // The manifest is not its own authority. Values that cannot be derived
  // from chain state — above all the tBTC destination, which nothing on
  // chain anchors — must match the separately reviewed constants, so a
  // corrupted manifest cannot be "verified" against itself.
  expectEqual(
    "manifest collateralRecipient vs reviewed anchor (helpers/recovery-anchors.ts)",
    addresses.collateralRecipient,
    anchors.COLLATERAL_RECIPIENT,
  )
  expectEqual(
    "manifest receiptPayer vs reviewed anchor",
    addresses.receiptPayer,
    anchors.RECEIPT_PAYER,
  )
  expectEqual(
    "manifest portal vs reviewed anchor",
    addresses.portal,
    anchors.PORTAL,
  )
  expectEqual(
    "manifest portalLogicOwner vs reviewed anchor",
    addresses.portalLogicOwner,
    anchors.PORTAL_LOGIC_OWNER,
  )
  expectEqual(
    "manifest originalImplementation vs reviewed anchor",
    addresses.originalImplementation,
    anchors.ORIGINAL_IMPLEMENTATION,
  )
  expectEqual(
    "manifest implementationRuntimeHash vs reviewed anchor (UPSTREAM.md)",
    manifest.implementationRuntimeHash,
    anchors.IMPLEMENTATION_RUNTIME_HASH,
  )

  // Compile-time provenance: the Portal source reconstructed in this
  // repository must compile to exactly the runtime bytecode the proxy points
  // at. This is the review gate RECOVERY.md step 1 relies on. Anchored to
  // UPSTREAM.md's reviewed constant (via the check above) so the gate cannot
  // silently re-anchor itself when the live implementation moves.
  const portalArtifact = await artifacts.readArtifact("Portal")
  const compiledPortalHash = ethers.keccak256(portalArtifact.deployedBytecode)
  expectEqual(
    "compiled Portal runtime hash (run `npm run build`; requires evmVersion paris)",
    compiledPortalHash,
    anchors.IMPLEMENTATION_RUNTIME_HASH,
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

  // The execute-only external screen is the long pole: its first pass reads
  // complete history. Establish the live settlement owners at each candidate
  // hash, retain raw logs, and catch up missing tail ranges until the evaluated
  // block is fresh. All remaining core checks use that converged block.
  let externalStbtcReview: unknown = {
    requiredAtStage: "execute",
    status: "not run during prepare stage",
  }
  let externalStbtcFailure: string | undefined
  let block: Block
  if (STAGE === "execute") {
    const selectedEntries = manifest.settlements.map((settlement) => ({
      depositor: settlement.depositor,
      depositId: BigInt(settlement.depositId),
      amountWei: BigInt(settlement.amountWei),
    }))
    const history = createExternalStbtcLogHistory(
      addresses.tbtc,
      addresses.stbtc,
    )
    try {
      const converged = await evaluateAtConvergedLatest<
        ExternalStbtcScreenReport,
        Block
      >(ethers.provider, async (candidate) => {
        const { callOverrides: candidateOverrides } = pinnedBlockContext(
          candidate.number,
          candidate.hash,
        )
        // The reviewed Portal cannot re-mint debt into selected ids. Only
        // this identity makes excluding permanently skipped owners safe.
        await verifyPortalSinkIdentity(
          ethers.provider,
          candidateOverrides.blockTag,
        )
        const depositors = await readLiveSettlementOwners(
          selectedEntries,
          async (depositor, depositId) => {
            const deposit = await portal.deposits(
              depositor,
              addresses.tbtc,
              depositId,
              candidateOverrides,
            )
            return {
              balanceWei: BigInt(deposit.balance),
              receiptMintedWei: BigInt(deposit.receiptMinted),
              migrating: Number(deposit.tbtcMigrationState) !== 0,
            }
          },
        )
        return screenExternalStbtcHoldings(
          depositors,
          createEthersExternalStbtcReader(
            ethers.provider,
            addresses.tbtc,
            addresses.stbtc,
            candidate.number,
            candidate.hash,
            history,
          ),
        )
      })
      block = converged.block
      const externalGate = evaluateExternalStbtcGate(
        converged.result,
        process.env.RECOVERY_EXTERNAL_STBTC_REVIEW,
      )
      externalStbtcReview = {
        ...externalGate,
        blockNumber: block.number,
        blockHash: block.hash,
        historyScan: {
          initialBlockNumber: converged.initialBlock.number,
          initialBlockHash: converged.initialBlock.hash,
          passes: converged.passes,
          incrementalPasses: converged.passes - 1,
          completeThroughBlock: block.number,
          headLagBlocks: converged.headLagBlocks,
          maxHeadLagBlocks: MAX_CONVERGENCE_HEAD_LAG_BLOCKS,
        },
      }
      if (!externalGate.passed) {
        externalStbtcFailure = `external stBTC holdings review failed: ${externalGate.blockingReasons.join(
          "; ",
        )}. Cancel the operation using governanceBatch.cancelTransaction`
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : `${error}`
      externalStbtcReview = {
        passed: false,
        error: detail,
        historyScan: { status: "failed before latest-state convergence" },
      }
      externalStbtcFailure =
        "external stBTC holdings screen could not reach a fresh, complete " +
        `latest-state result: ${detail}. Cancel the operation using ` +
        "governanceBatch.cancelTransaction"

      // Continue at a newly resolved block so deterministic governance and
      // cancellation calldata can still be emitted. The retained external
      // failure makes a passing result impossible.
      const fallbackBlock = await ethers.provider.getBlock("latest")
      if (!fallbackBlock) {
        fail("latest block was not found after external-screen failure")
      }
      block = fallbackBlock
    }
  } else {
    const prepareBlock = await ethers.provider.getBlock(
      requestedBlock ?? "latest",
    )
    if (!prepareBlock) {
      fail(`block ${requestedBlock ?? "latest"} was not found`)
    }
    block = prepareBlock
  }

  // Every storage read, eth_call, code read, fee calculation, operation-state
  // check, and final output field below is derived from this one block hash.
  const { rpcBlockTag: blockTag, callOverrides } = pinnedBlockContext(
    block.number,
    block.hash,
  )
  const atSnapshotBlock = block.number === manifest.snapshotBlock

  // Selected-deposit drift handling: a mismatch against the reviewed
  // manifest is fatal at the snapshot block (the manifest itself would be
  // wrong) but only reported elsewhere — the projection below computes what
  // the drift-tolerant contract would actually settle.
  const driftMessages: string[] = []
  function expectMatch(
    label: string,
    actual: bigint | number | string,
    expected: bigint | number | string,
  ): void {
    if (actual.toString().toLowerCase() !== expected.toString().toLowerCase()) {
      if (atSnapshotBlock) {
        fail(
          `${label}: expected ${expected.toString()}, got ${actual.toString()}`,
        )
      }
      driftMessages.push(
        `${label}: manifest ${expected.toString()}, live ${actual.toString()}`,
      )
    }
  }

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
    callOverrides.blockTag,
  )
  expectEqual(
    "Portal implementation runtime hash",
    ethers.keccak256(implementationCode),
    manifest.implementationRuntimeHash,
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
      "function paused() view returns (bool)",
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
    stbtcPaused,
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
    stbtc.paused(callOverrides).catch((error: unknown) => {
      throw new Error(
        "stBTC paused() could not be read; the receipt burn path is " +
          `pause-gated, so this read is required: ${
            error instanceof Error ? error.message : `${error}`
          }`,
      )
    }),
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
  // CANCELLER is the documented escape hatch for a batch that must not
  // execute, so losing it between scheduling and execution is exactly as
  // consequential as losing EXECUTOR. Hard-fail at the execute stage rather
  // than only warning.
  if (STAGE === "execute" && !senderHasCancellerRole) {
    fail(
      `${addresses.portalLogicOwner} does not hold CANCELLER_ROLE on the ` +
        "timelock; the documented cancel-on-drift/abort path would be " +
        "unavailable if this run has to be aborted",
    )
  }
  if (!senderHasCancellerRole) {
    warn(
      `${addresses.portalLogicOwner} does not hold CANCELLER_ROLE on the ` +
        "timelock; the documented cancel-on-drift/abort path needs a canceller",
    )
  }
  // These roles are checked for the manifest-pinned governance account. This
  // script is read-only and has no signer, so it CANNOT know which of the
  // timelock's several role holders will actually submit the transaction.
  // RECOVERY_EXPECTED_SENDER lets an operator name that account so the roles
  // are verified for the address that will really sign.
  const expectedSender = process.env.RECOVERY_EXPECTED_SENDER
  let expectedSenderRoles: Record<string, boolean> | undefined
  if (expectedSender) {
    const sender = ethers.getAddress(expectedSender)
    const [senderProposer, senderExecutor, senderCanceller] = await Promise.all(
      [
        timelock.hasRole(PROPOSER_ROLE, sender, callOverrides),
        timelock.hasRole(EXECUTOR_ROLE, sender, callOverrides),
        timelock.hasRole(CANCELLER_ROLE, sender, callOverrides),
      ],
    )
    expectedSenderRoles = {
      account: sender,
      proposer: senderProposer,
      executor: senderExecutor,
      canceller: senderCanceller,
    } as unknown as Record<string, boolean>
    if (STAGE === "prepare" && !senderProposer) {
      fail(`RECOVERY_EXPECTED_SENDER ${sender} does not hold PROPOSER_ROLE`)
    }
    if (STAGE === "execute" && !senderExecutor) {
      fail(`RECOVERY_EXPECTED_SENDER ${sender} does not hold EXECUTOR_ROLE`)
    }
  } else {
    warn(
      "RECOVERY_EXPECTED_SENDER is unset: timelock roles were verified for " +
        `the manifest-pinned ${addresses.portalLogicOwner} only, which says ` +
        "nothing about the account that will actually submit the transaction",
    )
  }

  const roundAmount = BigInt(manifest.recoveryAmountWei)
  const manifestTotal = manifest.settlements.reduce(
    (total, settlement) => total + BigInt(settlement.amountWei),
    0n,
  )
  expectEqual("manifest settlement total", manifestTotal, roundAmount)
  let failureAfterOutput: string | undefined
  if (externalStbtcFailure) {
    failureAfterOutput = appendDeferredFailure(
      failureAfterOutput,
      externalStbtcFailure,
    )
  }

  // stBTC's receipt burn (burnReceipt) is gated by Acre's pause while
  // transferFrom is not, so against a paused stBTC recoverTbtc would pull
  // the shares and then revert the whole batch with EnforcedPause, leaving
  // Threshold's exact allowance outstanding to the proxy. Nothing here
  // controls that pause; the gate can only refuse to certify an executeBatch
  // that cannot succeed.
  if (stbtcPaused) {
    const message =
      "stBTC is paused (Acre's pause admin); burnReceipt reverts with " +
      "EnforcedPause, so executeBatch would revert. Wait for the unpause " +
      "and rerun"
    if (STAGE === "execute") {
      failureAfterOutput = appendDeferredFailure(failureAfterOutput, message)
    } else {
      warn(
        `${message} (a pause at the prepare stage does not block scheduling)`,
      )
    }
  }

  // Sufficiency checks live after the projection inputs are assembled. Token
  // funding and receipt-debt accounting use the selected deposits' live
  // settlement upper bound; the conservative projected total is not a safe
  // funding bound.

  // Threshold's one on-chain action. In the execute-stage rerun this is a
  // hard requirement — a green preflight must guarantee executeBatch cannot
  // revert inside safeTransferFrom.
  if (!hasExactRecoveryAllowance(BigInt(receiptPayerAllowance), roundAmount)) {
    const message =
      "receipt payer allowance to the Portal proxy is " +
      `${receiptPayerAllowance.toString()} but must equal exactly ` +
      `${roundAmount.toString()}; Threshold must approve the Portal ` +
      `proxy (${addresses.portal}) — not the recovery implementation — ` +
      "for exactly this round's settlement total"
    if (STAGE === "execute") {
      failureAfterOutput = appendDeferredFailure(failureAfterOutput, message)
    }
    if (STAGE === "prepare") {
      warn(`${message} (expected while preparing; required before execution)`)
    }
  } else if (STAGE === "prepare") {
    // The allowance is already in place at the prepare stage, which means it
    // was granted before the delay elapsed — the ordering RECOVERY.md warns
    // against, because it leaves Threshold's entire holding approved to an
    // upgradeable proxy for longer than necessary. Previously this produced
    // no output at all, since the check only fired on inequality.
    warn(
      "the exact recovery allowance is ALREADY granted to the Portal proxy " +
        "before scheduling; RECOVERY.md step 8 places this after the timelock " +
        "delay to minimize how long Threshold's holding is approved to an " +
        "upgradeable proxy. Revoke with approve(portal, 0) and re-grant " +
        "after the delay unless governance has accepted the exposure",
    )
  }

  const feeState = {
    feeIntegral: BigInt(fee.feeIntegral),
    lastFeeUpdateAt: BigInt(fee.lastFeeUpdateAt),
    annualFee: BigInt(fee.annualFee),
  }
  const effectiveFeeIntegral = effectiveFeeIntegralAt(
    feeState,
    BigInt(block.timestamp),
  )
  // Fees keep accruing between this preflight and the executeBatch
  // transaction. The under-collateralization classification in the
  // projection uses a drift-padded integral so a deposit sitting on the
  // boundary is conservatively projected as skipped rather than flipping
  // from "settles" to a skip after a green run. Exact-at-this-block fees
  // are still used for the snapshot equality checks and reported margins.
  const paddedFeeIntegral = effectiveFeeIntegralAt(
    feeState,
    BigInt(block.timestamp) + FEE_DRIFT_PAD_SECONDS,
  )

  const checkedSettlements = await Promise.all(
    manifest.settlements.map(async (settlement) => {
      const depositorAddress = ethers.getAddress(settlement.depositor)
      const deposit = await portal.deposits(
        depositorAddress,
        addresses.tbtc,
        settlement.depositId,
        callOverrides,
      )

      expectMatch(
        `deposit ${settlement.depositor}/${settlement.depositId} balance`,
        deposit.balance,
        settlement.preState.balanceWei,
      )
      expectMatch(
        `deposit ${settlement.depositor}/${settlement.depositId} debt`,
        deposit.receiptMinted,
        settlement.preState.receiptDebtWei,
      )
      expectMatch(
        `deposit ${settlement.depositor}/${settlement.depositId} fee owed`,
        deposit.feeOwed,
        settlement.preState.feeOwedWei,
      )
      expectMatch(
        `deposit ${settlement.depositor}/${settlement.depositId} fee integral`,
        deposit.lastFeeIntegral,
        settlement.preState.lastFeeIntegral,
      )
      expectMatch(
        `deposit ${settlement.depositor}/${settlement.depositId} migration state`,
        deposit.tbtcMigrationState,
        settlement.preState.migrationState,
      )

      const amount = BigInt(settlement.amountWei)
      // Manifest integrity, not drift: a zero or debt-exceeding amount at
      // the snapshot block means the selection itself is wrong.
      if (amount === 0n) {
        fail(
          `zero amount for deposit ${settlement.depositor}/${settlement.depositId}`,
        )
      }
      if (atSnapshotBlock && amount > BigInt(deposit.receiptMinted)) {
        fail(
          "amount exceeds snapshot debt for deposit " +
            `${settlement.depositor}/${settlement.depositId}`,
        )
      }

      const depositFeeInput = {
        feeOwedWei: BigInt(deposit.feeOwed),
        lastFeeIntegral: BigInt(deposit.lastFeeIntegral),
        receiptMintedWei: BigInt(deposit.receiptMinted),
      }
      const projectedFee = projectedFeeOwed(
        depositFeeInput,
        effectiveFeeIntegral,
      )
      const paddedFee = projectedFeeOwed(depositFeeInput, paddedFeeIntegral)
      const collateralMargin =
        BigInt(deposit.balance) - BigInt(deposit.receiptMinted) - projectedFee
      if (atSnapshotBlock && collateralMargin < 0n) {
        fail(
          `deposit ${settlement.depositor}/${settlement.depositId} is undercollateralized`,
        )
      }

      if (atSnapshotBlock) {
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
        depositorStbtcBalanceWei: settlement.depositorStbtcBalanceWei,
        depositorActiveDepositIds: settlement.depositorActiveDepositIds,
        currentBalanceWei: BigInt(deposit.balance),
        currentDebtWei: BigInt(deposit.receiptMinted),
        migrating: Number(deposit.tbtcMigrationState) !== 0,
        projectedFeeWei: projectedFee,
        paddedFeeWei: paddedFee,
        collateralMarginWei: collateralMargin,
      }
    }),
  )

  // Stranding capacity per selected owner, mirroring the contract's guard:
  // live non-migrating receipt debt summed over the reviewed active deposit
  // ids, minus the owner's live stBTC balance. The manifest supplies the id
  // lists (sorted, as the contract requires); their debt is read again at
  // this preflight's pinned block. A newly active id omitted from the
  // snapshot only makes the recomputation conservative.
  const byDepositor = new Map<
    string,
    {
      settled: bigint
      manifestActiveDebt: bigint
      manifestStbtcBalance: bigint
      activeDepositIds: string[]
    }
  >()
  const seenSettlementKeys = new Set<string>()
  checkedSettlements.forEach((settlement) => {
    // The generator can never emit a duplicate (depositor, depositId), so
    // one in the manifest means hand-editing or merge damage. On-chain a
    // duplicate settles once (the second entry clamps against decremented
    // storage), so calldata carrying one does not match what was reviewed.
    const settlementKey = `${settlement.depositor}:${settlement.depositId.toString()}`
    if (seenSettlementKeys.has(settlementKey)) {
      fail(
        `duplicate settlement entry for deposit ${settlement.depositor}/` +
          `${settlement.depositId.toString()}; fix the manifest`,
      )
    }
    seenSettlementKeys.add(settlementKey)

    const activeDepositIds = settlement.depositorActiveDepositIds
    if (!activeDepositIds.includes(settlement.depositId.toString())) {
      fail(
        `active deposit ids for ${settlement.depositor} do not include ` +
          `selected deposit ${settlement.depositId.toString()}`,
      )
    }

    const manifestActiveDebt = BigInt(settlement.depositorActiveDebtWei)
    const manifestStbtcBalance = BigInt(settlement.depositorStbtcBalanceWei)
    const existing = byDepositor.get(settlement.depositor)
    if (
      existing &&
      (existing.manifestActiveDebt !== manifestActiveDebt ||
        existing.manifestStbtcBalance !== manifestStbtcBalance ||
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
      manifestStbtcBalance,
      activeDepositIds,
    }
    entry.settled += settlement.amount
    byDepositor.set(settlement.depositor, entry)
  })

  const ownerCapacity = new Map<string, bigint>()
  const ownerReports = await Promise.all(
    Array.from(byDepositor.entries()).map(async ([depositor, entry]) => {
      const { totalDebt: liveActiveDebt } = await recomputeActiveReceiptDebt(
        entry.activeDepositIds,
        async (depositId) => {
          const deposit = await portal.deposits(
            depositor,
            addresses.tbtc,
            depositId,
            callOverrides,
          )
          return {
            receiptMintedWei: BigInt(deposit.receiptMinted),
            migrating: Number(deposit.tbtcMigrationState) !== 0,
          }
        },
      )
      if (atSnapshotBlock) {
        expectEqual(
          `depositor ${depositor} active debt at snapshot`,
          liveActiveDebt,
          entry.manifestActiveDebt,
        )
      }

      const stbtcBalance = BigInt(
        await stbtc.balanceOf(depositor, callOverrides),
      )
      // The manifest's recorded holdings are what reviewers do the
      // no-stranding arithmetic on, so re-derive them rather than trusting
      // the file. (Previously only the fork test checked this, despite the
      // field's own comment claiming the preflight did.)
      const manifestBalance = BigInt(entry.manifestStbtcBalance)
      if (atSnapshotBlock) {
        expectEqual(
          `depositor ${depositor} recorded stBTC balance at snapshot`,
          stbtcBalance,
          manifestBalance,
        )
      } else if (stbtcBalance !== manifestBalance) {
        driftMessages.push(
          `depositor ${depositor} stBTC balance: manifest ` +
            `${manifestBalance.toString()}, live ${stbtcBalance.toString()}`,
        )
      }
      const capacity =
        liveActiveDebt > stbtcBalance ? liveActiveDebt - stbtcBalance : 0n
      ownerCapacity.set(depositor, capacity)
      return {
        depositor,
        stbtcBalanceWei: stbtcBalance,
        liveActiveDebtWei: liveActiveDebt,
        requestedSettlementWei: entry.settled,
        strandingCapacityWei: capacity,
      }
    }),
  )

  // At the pinned snapshot, derive each excluded owner's complete set of
  // still-live receipt deposits from Portal history. Recomputing only the ids
  // supplied by the manifest would allow an id and its debt to be omitted
  // together. This targeted scan is intentionally snapshot-only: later debt
  // drift is handled by the recovery contract's skip/clamp behavior.
  const exclusionAddresses = (manifest.strandingExclusions ?? []).map(
    (exclusion) => ethers.getAddress(exclusion.depositor),
  )
  const snapshotActiveExclusionIds = new Map<string, bigint[]>()
  if (atSnapshotBlock && exclusionAddresses.length > 0) {
    const exclusionSet = new Set(exclusionAddresses)
    const candidates = new Map<string, Set<bigint>>()
    const depositorTopics = exclusionAddresses.map((depositor) =>
      ethers.zeroPadValue(depositor, 32),
    )
    const receiptLogs = await getLogsInChunks(
      ethers.provider,
      {
        address: addresses.portal,
        topics: [
          RECEIPT_MINTED_TOPIC,
          depositorTopics,
          ethers.zeroPadValue(addresses.tbtc, 32),
        ],
      },
      anchors.STBTC_DEPLOYMENT_BLOCK,
      block.number,
    )

    receiptLogs.forEach((log) => {
      if (log.topics.length < 4) {
        fail(`malformed ReceiptMinted log ${log.transactionHash}`)
      }
      const depositor = ethers.getAddress(`0x${log.topics[1].slice(-40)}`)
      if (!exclusionSet.has(depositor)) {
        fail(`unexpected depositor ${depositor} in filtered ReceiptMinted logs`)
      }
      const depositIds = candidates.get(depositor) ?? new Set<bigint>()
      depositIds.add(BigInt(log.topics[3]))
      candidates.set(depositor, depositIds)
    })

    await Promise.all(
      exclusionAddresses.map(async (depositor) => {
        const candidateIds = Array.from(candidates.get(depositor) ?? []).sort(
          (a, b) => {
            if (a === b) {
              return 0
            }
            return a < b ? -1 : 1
          },
        )
        const liveIds = (
          await Promise.all(
            candidateIds.map(async (depositId) => {
              const deposit = await portal.deposits(
                depositor,
                addresses.tbtc,
                depositId,
                callOverrides,
              )
              return BigInt(deposit.receiptMinted) > 0n ? depositId : undefined
            }),
          )
        ).filter((depositId): depositId is bigint => depositId !== undefined)
        snapshotActiveExclusionIds.set(depositor, liveIds)
      }),
    )
  }

  // The exclusions are the other half of the reviewed selection story: they
  // are why capacity that exists was not used. Re-read every listed deposit
  // so falsified debt totals or truncated per-owner metadata fail at the
  // snapshot. Completeness of the exclusion set itself remains established
  // by the generator's globally reconciled scan and governance's manifest
  // diff, not by trusting these summary fields.
  const exclusionReports = await Promise.all(
    (manifest.strandingExclusions ?? []).map(async (exclusion) => {
      const depositor = ethers.getAddress(exclusion.depositor)
      if (byDepositor.has(depositor)) {
        fail(`${depositor} appears in both settlements and strandingExclusions`)
      }

      const liveBalance = BigInt(
        await stbtc.balanceOf(depositor, callOverrides),
      )
      const inactiveDepositIds: bigint[] = []
      const { depositIds, totalDebt: liveActiveDebt } =
        await recomputeActiveReceiptDebt(
          exclusion.depositIds,
          async (depositId) => {
            const deposit = await portal.deposits(
              depositor,
              addresses.tbtc,
              depositId,
              callOverrides,
            )
            const receiptMintedWei = BigInt(deposit.receiptMinted)
            if (receiptMintedWei === 0n) {
              inactiveDepositIds.push(depositId)
            }
            return {
              receiptMintedWei,
              migrating: Number(deposit.tbtcMigrationState) !== 0,
            }
          },
        )
      if (atSnapshotBlock) {
        assertExactActiveDepositIds(
          `excluded depositor ${depositor}`,
          depositIds,
          snapshotActiveExclusionIds.get(depositor) ?? [],
        )
        expectEqual(
          `excluded depositor ${depositor} recorded stBTC balance`,
          liveBalance,
          exclusion.stbtcBalanceWei,
        )
        expectEqual(
          `excluded depositor ${depositor} active debt`,
          liveActiveDebt,
          exclusion.activeDebtWei,
        )
        if (inactiveDepositIds.length > 0) {
          fail(
            `excluded depositor ${depositor} lists deposit ids with no ` +
              `receipt debt at the snapshot: ${inactiveDepositIds.join(", ")}`,
          )
        }
      }
      return {
        depositor,
        recordedStbtcBalanceWei: BigInt(exclusion.stbtcBalanceWei),
        liveStbtcBalanceWei: liveBalance,
        recordedActiveDebtWei: BigInt(exclusion.activeDebtWei),
        liveActiveDebtWei: liveActiveDebt,
        activeDepositIds: depositIds,
      }
    }),
  )

  // Project the clamped execution outcome the contract will produce. The
  // contract enforces the stranding guard atomically, so preflight's job is
  // to predict the settled amount, not to re-block what the contract already
  // handles safely (a hard failure on a wei-level donation would recreate
  // the process-layer veto).
  const projectionInputs: SettlementProjectionInput[] = checkedSettlements.map(
    (settlement) => ({
      depositor: settlement.depositor,
      depositId: settlement.depositId,
      amountWei: settlement.amount,
      deposit: {
        balanceWei: settlement.currentBalanceWei,
        receiptMintedWei: settlement.currentDebtWei,
        migrating: settlement.migrating,
        projectedFeeWei: settlement.paddedFeeWei,
      },
    }),
  )
  const { projected, projectedTotalWei } = projectSettlementOutcome(
    projectionInputs,
    ownerCapacity,
  )
  const liveSettlementUpperBoundWei =
    maximumSettlementFromLiveDebt(projectionInputs)
  const projectedResidualWei = manifestTotal - projectedTotalWei

  // Funding and receipt-debt accounting use the live settlement upper bound.
  // It excludes entries the contract can no longer settle and clamps the
  // rest to live debt, but deliberately ignores fee and owner-capacity skips
  // that make the projection a lower bound. Under the verified Portal, debt
  // cannot be re-minted into these reviewed deposit ids, so this is the true
  // maximum recoverTbtc can pull, burn, and release after this pinned read.
  //
  // Deferred rather than thrown: funding that moved after scheduling is
  // exactly the case where the operator needs the operation id and cancel
  // calldata below, and the output is emitted with preflightPassed: false.
  const sufficiencyProblems: string[] = []
  if (BigInt(portalTbtcBalance) < liveSettlementUpperBoundWei) {
    sufficiencyProblems.push(
      `Portal holds ${portalTbtcBalance.toString()} tBTC, below the live ` +
        `settlement upper bound ${liveSettlementUpperBoundWei.toString()}`,
    )
  }
  if (BigInt(receiptPayerBalance) < liveSettlementUpperBoundWei) {
    sufficiencyProblems.push(
      `receipt payer holds ${receiptPayerBalance.toString()} stBTC, below the ` +
        `live settlement upper bound ${liveSettlementUpperBoundWei.toString()}`,
    )
  }
  if (BigInt(portalStbtcDebt) < liveSettlementUpperBoundWei) {
    sufficiencyProblems.push(
      `Portal stBTC debt ${portalStbtcDebt.toString()} is below the maximum ` +
        `live settlement ${liveSettlementUpperBoundWei.toString()}`,
    )
  }
  if (BigInt(fee.totalMinted) < liveSettlementUpperBoundWei) {
    sufficiencyProblems.push(
      `tBTC-specific receipt debt ${fee.totalMinted.toString()} is below the ` +
        `maximum live settlement ${liveSettlementUpperBoundWei.toString()}`,
    )
  }
  if (sufficiencyProblems.length > 0) {
    failureAfterOutput = appendDeferredFailure(
      failureAfterOutput,
      `funding/receipt-debt sufficiency failed: ${sufficiencyProblems.join("; ")}`,
    )
  }

  if (driftMessages.length > 0) {
    warn(
      "selected deposit state drifted from the manifest (execution will " +
        `clamp accordingly):\n  - ${driftMessages.join("\n  - ")}`,
    )
  }

  if (projectedTotalWei === 0n) {
    const message =
      "no settlement would apply at the current state — executeBatch would " +
      "revert with NothingSettled"
    if (STAGE === "prepare") {
      fail(`${message}; regenerate the manifest`)
    }
    failureAfterOutput = appendDeferredFailure(
      failureAfterOutput,
      `${message}; cancel the operation using the cancelTransaction calldata ` +
        "printed in governanceBatch and re-pin the manifest",
    )
  } else if (projectedResidualWei > 0n) {
    const message =
      `projected settlement is ${projectedTotalWei.toString()} of the ` +
      `reviewed ${manifestTotal.toString()} ` +
      `(${projectedResidualWei.toString()} residual would remain with the ` +
      "receipt payer for a follow-up round)"
    // A materially reduced projection needs an explicit governance decision
    // at BOTH stages — at prepare because the selection should simply be
    // regenerated, and at execute because that is when drift has actually
    // accumulated and the choice is execute-reduced or cancel. Wei-level
    // noise (up to the generator's dust threshold per selected owner) is
    // tolerated.
    if (
      exceedsRecoveryReductionTolerance(
        projectedResidualWei,
        BigInt(manifest.strandingDustWei),
        ownerReports.length,
      ) &&
      process.env.RECOVERY_ACCEPT_REDUCED_RECOVERY !== "1"
    ) {
      if (STAGE === "prepare") {
        fail(
          `${message}. Regenerate the manifest ` +
            "(scripts/generate-stbtc-recovery-manifest.ts) or, if " +
            "governance accepts recovering less in this round, set " +
            "RECOVERY_ACCEPT_REDUCED_RECOVERY=1",
        )
      }
      failureAfterOutput = appendDeferredFailure(
        failureAfterOutput,
        `${message}. Cancel the scheduled operation using the ` +
          "cancelTransaction calldata printed in governanceBatch and re-pin, " +
          "or — only with explicit governance acceptance of the reduced " +
          "round — set RECOVERY_ACCEPT_REDUCED_RECOVERY=1 and rerun",
      )
    } else {
      warn(message)
      warn(
        "after execution the receipt payer must revoke the residual allowance " +
          `with approve(${addresses.portal}, 0) — the round consumes only the ` +
          "settled amount and the remainder stays approved to the proxy",
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
    roundAmount,
  ] as const
  const depositorContexts = Array.from(byDepositor.entries()).map(
    ([depositor, entry]) => ({
      depositor,
      activeDepositIds: entry.activeDepositIds.map((id) => BigInt(id)),
    }),
  )
  const recoveryCall = recoveryFactory.interface.encodeFunctionData(
    "recoverTbtc",
    [
      checkedSettlements.map(({ depositor, depositId, amount }) => ({
        depositor,
        depositId,
        amount,
      })),
      depositorContexts,
    ],
  )
  const approvalCall = new ethers.Interface([
    "function approve(address spender,uint256 amount) returns (bool)",
  ]).encodeFunctionData("approve", [addresses.portal, roundAmount])

  const manifestBytes = readFileSync(recoveryManifestPath)
  const manifestHash = ethers.keccak256(manifestBytes)
  // Salt input: the JSON content, independent of whitespace and line endings
  // (see operationSalt). Any value change — a re-pin — still changes it.
  const manifestContentHash = ethers.keccak256(
    ethers.toUtf8Bytes(
      JSON.stringify(JSON.parse(manifestBytes.toString("utf8"))),
    ),
  )

  const verifiedAt: Record<string, unknown> = {
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    blockHashRevalidated: false,
    latestHeadRevalidated: STAGE === "prepare" ? "not required" : false,
    headLagBlocks: STAGE === "prepare" ? "not required" : undefined,
    maxHeadLagBlocks:
      STAGE === "prepare" ? "not required" : MAX_EXECUTE_HEAD_LAG_BLOCKS,
  }
  const output: Record<string, unknown> = {
    stage: STAGE,
    preflightPassed: failureAfterOutput === undefined,
    blockingFailure: failureAfterOutput,
    verifiedAt,
    provenance: {
      manifestPath: recoveryManifestPath,
      manifestHash,
      manifestContentHash,
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
        note:
          "roles of the manifest-pinned governance account; the timelock has " +
          "several role holders and this script cannot know which will sign",
      },
      expectedSenderRoles:
        expectedSenderRoles ?? "unset (RECOVERY_EXPECTED_SENDER)",
      portalTbtcBalanceWei: portalTbtcBalance,
      portalStbtcDebtWei: portalStbtcDebt,
      tbtcReceiptDebtWei: fee.totalMinted,
      feeLastUpdateAt: fee.lastFeeUpdateAt,
      storedFeeIntegral: fee.feeIntegral,
      annualFeePercent: fee.annualFee,
      effectiveFeeIntegral,
      receiptPayerStbtcBalanceWei: receiptPayerBalance,
      receiptPayerAllowanceWei: receiptPayerAllowance,
      stbtcPaused,
    },
    settlementProjection: {
      manifestTotalWei: manifestTotal,
      liveSettlementUpperBoundWei,
      projectedTotalWei,
      projectedResidualWei,
      note:
        "the projection is a conservative LOWER bound (fees padded, capacity " +
        "read at this block); all funding and receipt-debt sufficiency is " +
        "checked against liveSettlementUpperBoundWei",
      owners: ownerReports,
      entries: projected,
    },
    externalStbtcReview,
    strandingExclusions: exclusionReports,
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

  if (recoveryImplementation) {
    const recoveryAddress = recoveryImplementation
    // Every deployed-implementation problem below is deferred rather than
    // thrown. The batch payloads, operation id, and cancel calldata depend
    // only on the reviewed addresses and this address, and a scheduled batch
    // whose implementation no longer verifies is precisely the case where
    // the operator needs the cancel calldata printed. Schedule/execute
    // calldata is withheld instead, so an unverified implementation is never
    // handed out as a batch to sign.
    const recoveryProblems: string[] = []
    const expectDeployed = (
      label: string,
      actual: bigint | number | string,
      expected: bigint | number | string,
    ): void => {
      if (
        actual.toString().toLowerCase() !== expected.toString().toLowerCase()
      ) {
        recoveryProblems.push(
          `${label}: expected ${expected.toString()}, got ${actual.toString()}`,
        )
      }
    }
    const recoveryCode = await ethers.provider.getCode(
      recoveryAddress,
      callOverrides.blockTag,
    )

    // The immutable is an upper bound so a residual round can reuse this
    // deployed, reviewed implementation with a smaller fresh manifest. It
    // must be anchored externally, never to the deployed contract's own
    // getter — otherwise the occurrence-by-occurrence bytecode check below
    // would be circular for this one immutable. Round one anchors to the
    // manifest total; a residual round passes the original deployment's
    // amount via RECOVERY_DEPLOYED_MAX_WEI.
    const expectedMaxAmount = process.env.RECOVERY_DEPLOYED_MAX_WEI
      ? BigInt(process.env.RECOVERY_DEPLOYED_MAX_WEI)
      : manifestTotal
    if (expectedMaxAmount < manifestTotal) {
      recoveryProblems.push(
        `RECOVERY_DEPLOYED_MAX_WEI ${expectedMaxAmount.toString()} is below ` +
          `this round's settlement total ${manifestTotal.toString()}`,
      )
    }

    let deployedMaxAmount: bigint | undefined
    let bytecodeVerification: RecoveryBytecodeVerification | undefined
    if (recoveryCode === "0x") {
      recoveryProblems.push(
        `no code at RECOVERY_IMPLEMENTATION ${recoveryAddress}`,
      )
    } else {
      try {
        const configuredRecovery = new ethers.Contract(
          recoveryAddress,
          recoveryFactory.interface,
          ethers.provider,
        )
        const [
          deployedPortal,
          deployedAuthority,
          deployedPayer,
          deployedRecipient,
          deployedTbtc,
          deployedReceiptToken,
          deployedMax,
        ] = await Promise.all([
          configuredRecovery.EXPECTED_PORTAL(callOverrides),
          configuredRecovery.RECOVERY_AUTHORITY(callOverrides),
          configuredRecovery.RECEIPT_PAYER(callOverrides),
          configuredRecovery.COLLATERAL_RECIPIENT(callOverrides),
          configuredRecovery.EXPECTED_TBTC(callOverrides),
          configuredRecovery.EXPECTED_RECEIPT_TOKEN(callOverrides),
          configuredRecovery.EXPECTED_MAX_RECOVERY_AMOUNT(callOverrides),
        ])
        deployedMaxAmount = BigInt(deployedMax)
        expectDeployed(
          "recovery EXPECTED_PORTAL",
          deployedPortal,
          addresses.portal,
        )
        expectDeployed(
          "recovery RECOVERY_AUTHORITY",
          deployedAuthority,
          addresses.proxyAdmin,
        )
        expectDeployed(
          "recovery RECEIPT_PAYER",
          deployedPayer,
          addresses.receiptPayer,
        )
        expectDeployed(
          "recovery COLLATERAL_RECIPIENT",
          deployedRecipient,
          addresses.collateralRecipient,
        )
        expectDeployed("recovery EXPECTED_TBTC", deployedTbtc, addresses.tbtc)
        expectDeployed(
          "recovery EXPECTED_RECEIPT_TOKEN",
          deployedReceiptToken,
          addresses.stbtc,
        )
        expectDeployed(
          "recovery EXPECTED_MAX_RECOVERY_AMOUNT (set " +
            "RECOVERY_DEPLOYED_MAX_WEI for a residual round reusing the " +
            "original deployment)",
          deployedMaxAmount,
          expectedMaxAmount,
        )
        if (expectedMaxAmount > manifestTotal) {
          warn(
            `deployed EXPECTED_MAX_RECOVERY_AMOUNT ${deployedMaxAmount} ` +
              `exceeds this round's total ${manifestTotal.toString()} ` +
              "(expected for a residual round reusing the original " +
              "deployment)",
          )
        }

        // The deployed implementation must be byte-for-byte the compiled
        // local artifact. Every immutable occurrence is checked against the
        // externally anchored expected values before the ranges are masked
        // for the remaining-code comparison; checking only the seven getters
        // is insufficient because custom initcode can patch separate
        // occurrences differently.
        const expectedRecoveryImmutables: RecoveryImmutableValues = {
          EXPECTED_PORTAL: addresses.portal,
          RECOVERY_AUTHORITY: addresses.proxyAdmin,
          RECEIPT_PAYER: addresses.receiptPayer,
          COLLATERAL_RECIPIENT: addresses.collateralRecipient,
          EXPECTED_TBTC: addresses.tbtc,
          EXPECTED_RECEIPT_TOKEN: addresses.stbtc,
          EXPECTED_MAX_RECOVERY_AMOUNT: expectedMaxAmount,
        }
        bytecodeVerification = await verifyRecoveryBytecode(
          ethers.provider,
          recoveryAddress,
          expectedRecoveryImmutables,
          callOverrides.blockTag,
        )
      } catch (error) {
        recoveryProblems.push(
          error instanceof Error ? error.message : `${error}`,
        )
      }
    }
    const bytecodeVerified = recoveryProblems.length === 0
    if (!bytecodeVerified) {
      failureAfterOutput = appendDeferredFailure(
        failureAfterOutput,
        `deployed recovery implementation ${recoveryAddress} failed ` +
          `verification: ${recoveryProblems.join("; ")}`,
      )
    }

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

    const { targets, values, payloads } = buildRecoveryBatchPayloads({
      portal: addresses.portal,
      proxyAdmin: addresses.proxyAdmin,
      recoveryImplementation: recoveryAddress,
      originalImplementation: addresses.originalImplementation,
      recoverCalldata: recoveryCall,
    })
    const predecessor = ethers.ZeroHash
    const { salt, derivation } = operationSalt(manifestContentHash)
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

    if (STAGE === "execute" && process.env.RECOVERY_SALT === undefined) {
      warn(
        "RECOVERY_SALT is unset, so the operation id was re-derived from the " +
          "manifest content; pass the salt recorded from the scheduling " +
          "run's governanceBatch.salt so a manifest edit cannot point this " +
          "run at a different operation id",
      )
    }
    if (STAGE === "execute" && operationState !== "ready") {
      const unscheduledGuidance =
        operationState === "unset"
          ? ". Nothing is scheduled under this id: if the batch was " +
            "scheduled by an earlier run, the manifest content or " +
            "RECOVERY_SALT differs from that run — rerun with " +
            "RECOVERY_SALT=<the salt it printed>, or take the scheduled id " +
            "from the timelock's CallScheduled event. No cancel calldata is " +
            "printed for an unscheduled id"
          : ""
      failureAfterOutput = appendDeferredFailure(
        failureAfterOutput,
        `timelock operation ${operationId} is "${operationState}" ` +
          `(timestamp ${operationTimestamp.toString()}); executeBatch ` +
          `requires it to be ready${unscheduledGuidance}`,
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

    const withheld = (reason: string) => ({ withheld: true, reason })
    const unverifiedBatch =
      "the deployed recovery implementation failed verification; this " +
      "batch must not be signed"
    output.governanceBatch = {
      recoveryImplementation: recoveryAddress,
      recoveryImplementationRuntimeHash:
        bytecodeVerification?.deployedRuntimeHash ??
        ethers.keccak256(recoveryCode),
      recoveryArtifactRuntimeHash:
        bytecodeVerification?.artifactRuntimeHash ?? "not verified",
      recoveryMaxAmountWei: deployedMaxAmount ?? "unreadable",
      bytecodeVerified,
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
      scheduleTransaction: bytecodeVerified
        ? {
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
          }
        : withheld(unverifiedBatch),
      executeTransaction: bytecodeVerified
        ? {
            target: addresses.proxyAdminOwnerTimelock,
            value: "0",
            calldata: timelockInterface.encodeFunctionData("executeBatch", [
              targets,
              values,
              payloads,
              predecessor,
              salt,
            ]),
          }
        : withheld(unverifiedBatch),
      // Cancel calldata is the abort path and is printed even for an
      // unverified implementation — but never for an id that is not
      // scheduled, because cancelling it would revert while the real
      // operation stayed pending.
      cancelTransaction:
        STAGE === "execute" && operationState === "unset"
          ? withheld(
              `operation ${operationId} is not scheduled under salt ${salt}; ` +
                "cancel with the salt/id recorded at scheduling",
            )
          : {
              target: addresses.proxyAdminOwnerTimelock,
              value: "0",
              calldata: timelockInterface.encodeFunctionData("cancel", [
                operationId,
              ]),
            },
    }
  }

  // Range scans cannot use a block-hash endpoint. Re-fetch the pinned height
  // and the manifest's generating snapshot only after every dependent read is
  // complete. Execute also requires the head to be at most
  // MAX_EXECUTE_HEAD_LAG_BLOCKS past the evaluated block, which must still
  // be canonical. Fail closed before a result can be emitted as passing if
  // any of those identities changed.
  try {
    await assertManifestSnapshotCanonical(ethers.provider, manifest)
    await assertPinnedBlockHashUnchanged(
      ethers.provider,
      block.number,
      block.hash,
    )
    verifiedAt.blockHashRevalidated = true
    if (STAGE === "execute") {
      const { headLagBlocks } = await assertStillLatestBlock(
        ethers.provider,
        block.number,
        block.hash,
      )
      verifiedAt.latestHeadRevalidated = true
      verifiedAt.headLagBlocks = headLagBlocks
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : `${error}`
    const scheduledOperationGuidance = recoveryImplementation
      ? ", cancel any scheduled operation using " +
        "governanceBatch.cancelTransaction"
      : ""
    failureAfterOutput = appendDeferredFailure(
      failureAfterOutput,
      `final block canonicality/freshness check failed: ${detail}. Discard this preflight ` +
        `result${scheduledOperationGuidance}, and rerun`,
    )
  }

  // Operation readiness and canonicality are known only after deriving the
  // governance batch and completing every RPC read. Refresh these fields
  // before serialization so late failures cannot leave a misleading pass.
  output.preflightPassed = failureAfterOutput === undefined
  output.blockingFailure = failureAfterOutput

  emitRecoveryPreflightResult(
    stringify(output),
    failureAfterOutput,
    (serializedOutput) => {
      // eslint-disable-next-line no-console
      console.log(serializedOutput)
    },
  )
}

type RecoveryManifestAddresses = (typeof manifest)["addresses"]

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
