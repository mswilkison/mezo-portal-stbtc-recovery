import { ethers } from "ethers"

export type RecoveryBlockIdentity = {
  number: number
  hash: string | null
}

type BlockIdentityProvider = {
  getBlock(
    blockNumber: number | "latest",
  ): Promise<RecoveryBlockIdentity | null>
}

export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
export const ONE_YEAR = 365n * 24n * 60n * 60n
export const FEE_PRECISION = 10n ** 18n

const PROXY_ADMIN_INTERFACE = new ethers.Interface([
  "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
])

export function pinnedBlockContext(
  blockNumber: number,
  blockHash: string | null,
): {
  rpcBlockTag: { blockHash: string; requireCanonical: true }
  callOverrides: { blockTag: string }
} {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid preflight block number ${blockNumber}`)
  }
  if (blockHash === null || !ethers.isHexString(blockHash, 32)) {
    throw new Error(`invalid preflight block hash ${blockHash ?? "null"}`)
  }

  return {
    rpcBlockTag: { blockHash, requireCanonical: true },
    callOverrides: { blockTag: blockHash },
  }
}

// Historical log ranges require numeric endpoints, so re-check the resolved
// block after every dependent read even though snapshot state calls are pinned
// to its hash. A result is safe to accept only if that hash is still canonical
// at the chosen height when the scan completes.
export async function assertPinnedBlockHashUnchanged(
  provider: BlockIdentityProvider,
  blockNumber: number,
  expectedBlockHash: string | null,
): Promise<void> {
  if (expectedBlockHash === null) {
    throw new Error(`pinned block ${blockNumber} has no hash`)
  }

  const canonicalBlock = await provider.getBlock(blockNumber)
  if (!canonicalBlock || canonicalBlock.hash === null) {
    throw new Error(
      `pinned block ${blockNumber} could not be re-fetched with a canonical hash`,
    )
  }
  if (canonicalBlock.number !== blockNumber) {
    throw new Error(
      `pinned block ${blockNumber} re-fetch returned height ${canonicalBlock.number}`,
    )
  }
  if (canonicalBlock.hash.toLowerCase() !== expectedBlockHash.toLowerCase()) {
    throw new Error(
      `pinned block ${blockNumber} was reorged during the scan: started at ` +
        `${expectedBlockHash}, now canonical at ${canonicalBlock.hash}`,
    )
  }
}

function requireBlockIdentity(
  block: RecoveryBlockIdentity | null,
  label: string,
): asserts block is { number: number; hash: string } {
  if (
    !block ||
    !Number.isSafeInteger(block.number) ||
    block.number < 0 ||
    block.hash === null ||
    !ethers.isHexString(block.hash, 32)
  ) {
    throw new Error(
      `${label} could not be resolved with a valid block identity`,
    )
  }
}

function sameBlockIdentity(
  left: { number: number; hash: string },
  right: { number: number; hash: string },
): boolean {
  return (
    left.number === right.number &&
    left.hash.toLowerCase() === right.hash.toLowerCase()
  )
}

// A deployment-to-head archive scan can span several new blocks. Re-run its
// caller-supplied evaluation at successively newer heads until the evaluated
// block is still `latest` immediately afterward. The caller may retain a
// canonical history cache between passes, making every pass after the first
// an incremental tail scan. Each committed boundary is revalidated before it
// is reused, and the loop is bounded so an advancing or inconsistent RPC
// fails closed rather than hanging an execute-stage preflight forever.
export async function evaluateAtConvergedLatest<
  T,
  B extends RecoveryBlockIdentity,
>(
  provider: BlockIdentityProvider,
  evaluateAtBlock: (block: B & { hash: string }) => Promise<T>,
  maxPasses = 5,
): Promise<{
  initialBlock: B & { hash: string }
  block: B & { hash: string }
  result: T
  passes: number
}> {
  if (!Number.isSafeInteger(maxPasses) || maxPasses <= 0) {
    throw new Error("latest-state convergence pass limit must be positive")
  }

  const initialCandidate = (await provider.getBlock("latest")) as B | null
  requireBlockIdentity(initialCandidate, "latest block")
  let candidate = initialCandidate as B & { hash: string }
  const initialBlock = candidate
  let committedBlock: (B & { hash: string }) | undefined

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (committedBlock) {
      // eslint-disable-next-line no-await-in-loop
      await assertPinnedBlockHashUnchanged(
        provider,
        committedBlock.number,
        committedBlock.hash,
      )
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await evaluateAtBlock(candidate)
    // eslint-disable-next-line no-await-in-loop
    await assertPinnedBlockHashUnchanged(
      provider,
      candidate.number,
      candidate.hash,
    )

    // eslint-disable-next-line no-await-in-loop
    const resolvedLatest = (await provider.getBlock("latest")) as B | null
    requireBlockIdentity(resolvedLatest, "latest block after state evaluation")
    const latest = resolvedLatest as B & { hash: string }
    if (sameBlockIdentity(candidate, latest)) {
      return { initialBlock, block: candidate, result, passes: pass }
    }
    if (latest.number <= candidate.number) {
      throw new Error(
        "latest block changed inconsistently during state evaluation: " +
          `evaluated ${candidate.number} (${candidate.hash}), resolved ` +
          `${latest.number} (${latest.hash}) afterward`,
      )
    }

    committedBlock = candidate
    candidate = latest
  }

  throw new Error(
    `latest block advanced during all ${maxPasses.toString()} state ` +
      "evaluation passes; rerun against a responsive archive RPC",
  )
}

// Execute-stage state checks may themselves outlive the converged archive
// tail scan. A green result is emitted only if no newer head appeared while
// those final hash-pinned checks were running.
export async function assertStillLatestBlock(
  provider: BlockIdentityProvider,
  expectedBlockNumber: number,
  expectedBlockHash: string | null,
): Promise<void> {
  if (expectedBlockHash === null) {
    throw new Error(`validated block ${expectedBlockNumber} has no hash`)
  }
  const latest = await provider.getBlock("latest")
  requireBlockIdentity(latest, "latest block at preflight completion")
  if (
    latest.number !== expectedBlockNumber ||
    latest.hash.toLowerCase() !== expectedBlockHash.toLowerCase()
  ) {
    throw new Error(
      "execute-stage state became stale before preflight completion: " +
        `validated block ${expectedBlockNumber} (${expectedBlockHash}), ` +
        `latest is ${latest.number} (${latest.hash})`,
    )
  }
}

export function hasExactRecoveryAllowance(
  allowance: bigint,
  recoveryAmount: bigint,
): boolean {
  return allowance === recoveryAmount
}

export function exceedsRecoveryReductionTolerance(
  projectedResidualWei: bigint,
  strandingDustWei: bigint,
  selectedOwnerCount: number,
): boolean {
  if (projectedResidualWei < 0n) {
    throw new Error("projected recovery residual must be non-negative")
  }
  if (strandingDustWei < 0n) {
    throw new Error("stranding dust threshold must be non-negative")
  }
  if (!Number.isSafeInteger(selectedOwnerCount) || selectedOwnerCount < 0) {
    throw new Error("selected owner count must be a non-negative safe integer")
  }

  return projectedResidualWei > strandingDustWei * BigInt(selectedOwnerCount)
}

// The Portal's lazy fee accounting, in one place. The generator records
// these values into the manifest and the preflight recomputes them for its
// snapshot equality checks and projections; a fee-model change must not be
// able to split the two. (The unit tests keep their own independent copy of
// the formula on purpose — it is the oracle these helpers are tested
// against.)
export function annualFeeRatePerSecond(annualFeePercent: bigint): bigint {
  return (annualFeePercent * 10n ** 16n) / ONE_YEAR
}

export function effectiveFeeIntegralAt(
  fee: { feeIntegral: bigint; lastFeeUpdateAt: bigint; annualFee: bigint },
  timestamp: bigint,
): bigint {
  return (
    fee.feeIntegral +
    (timestamp - fee.lastFeeUpdateAt) * annualFeeRatePerSecond(fee.annualFee)
  )
}

export function projectedFeeOwed(
  deposit: {
    feeOwedWei: bigint
    lastFeeIntegral: bigint
    receiptMintedWei: bigint
  },
  effectiveIntegral: bigint,
): bigint {
  return (
    deposit.feeOwedWei +
    ((effectiveIntegral - deposit.lastFeeIntegral) * deposit.receiptMintedWei) /
      FEE_PRECISION
  )
}

export type ActiveDepositRecord = {
  receiptMintedWei: bigint
  migrating: boolean
}

// Recomputes a depositor's repayable receipt debt from their reviewed active
// deposit id list, mirroring the recovery contract's stranding guard: ids
// must be unique and sorted ascending (the contract reverts otherwise), and
// debt on a deposit that entered tBTC migration is excluded, conservatively
// treating it as not repayable through the normal path.
export async function recomputeActiveReceiptDebt(
  depositIds: readonly string[],
  readDeposit: (depositId: bigint) => Promise<ActiveDepositRecord>,
): Promise<{ depositIds: bigint[]; totalDebt: bigint }> {
  if (depositIds.length === 0) {
    throw new Error("active deposit id list is empty")
  }

  const parsedIds = depositIds.map((depositId) => BigInt(depositId))
  parsedIds.forEach((depositId, index) => {
    if (index > 0 && depositId <= parsedIds[index - 1]) {
      throw new Error(
        "active deposit id list must be strictly ascending " +
          "(the recovery contract rejects unsorted or duplicated ids)",
      )
    }
  })

  const records = await Promise.all(
    parsedIds.map((depositId) => readDeposit(depositId)),
  )
  return {
    depositIds: parsedIds,
    totalDebt: records.reduce(
      (total, record) =>
        record.migrating ? total : total + record.receiptMintedWei,
      0n,
    ),
  }
}

// The debt total alone does not prove that reviewed exclusion metadata is
// complete: an omitted deposit id and a correspondingly reduced total would
// agree. Compare the reviewed ids with the independently event-derived live
// set before trusting the exclusion at the snapshot block.
export function assertExactActiveDepositIds(
  label: string,
  reviewedIds: readonly bigint[],
  eventDerivedIds: readonly bigint[],
): void {
  if (
    reviewedIds.length !== eventDerivedIds.length ||
    reviewedIds.some((depositId, index) => depositId !== eventDerivedIds[index])
  ) {
    throw new Error(
      `${label} active deposit ids do not match Portal history: reviewed ` +
        `[${reviewedIds.join(", ")}], live [${eventDerivedIds.join(", ")}]`,
    )
  }
}

export type SettlementProjectionInput = {
  depositor: string
  depositId: bigint
  amountWei: bigint
  deposit: {
    balanceWei: bigint
    receiptMintedWei: bigint
    migrating: boolean
    projectedFeeWei: bigint
  }
}

export type ProjectedSettlement = {
  depositor: string
  depositId: bigint
  requestedWei: bigint
  projectedWei: bigint
  skipReason?:
    | "DepositNotFound"
    | "DepositMigrating"
    | "DebtAlreadyRepaid"
    | "Undercollateralized"
    | "ReceiptHolderWouldBeStranded"
}

// Upper-bounds what `recoverTbtc` can settle from the selected deposits at
// the pinned block without relying on the fee-padding or owner-capacity
// projection. Permanently unavailable entries (deleted or migrating) are
// excluded, each remaining request is clamped to that deposit's live debt,
// and repeated keys consume the same debt sequentially just as the contract
// does. Unlike the manifest total, this bound falls with ordinary repayments
// and withdrawals; unlike the conservative projection, it never drops merely
// because a fee boundary or owner balance currently causes a live entry to
// be skipped or clamped.
export function maximumSettlementFromLiveDebt(
  entries: readonly SettlementProjectionInput[],
): bigint {
  const remainingDeposit = new Map<string, bigint>()
  let maximumTotalWei = 0n

  entries.forEach((entry) => {
    if (entry.amountWei <= 0n) {
      throw new Error(
        `settlement amount for ${entry.depositor}/${entry.depositId} ` +
          "must be positive",
      )
    }
    if (entry.deposit.balanceWei === 0n || entry.deposit.migrating) {
      return
    }

    const depositKey = `${entry.depositor}:${entry.depositId.toString()}`
    const depositDebt =
      remainingDeposit.get(depositKey) ?? entry.deposit.receiptMintedWei
    const settle = entry.amountWei < depositDebt ? entry.amountWei : depositDebt

    remainingDeposit.set(depositKey, depositDebt - settle)
    maximumTotalWei += settle
  })

  return maximumTotalWei
}

// Execute-stage abort gates must still terminate nonzero, but only after the
// serialized governance output (including cancel calldata) is emitted.
// Keeping the ordering in one tested helper prevents a future refactor from
// restoring the abort-before-calldata failure mode.
export function emitRecoveryPreflightResult(
  serializedOutput: string,
  failureAfterOutput: string | undefined,
  emit: (output: string) => void,
): void {
  emit(serializedOutput)
  if (failureAfterOutput) {
    throw new Error(`Recovery preflight failed: ${failureAfterOutput}`)
  }
}

// Projects what `recoverTbtc` will actually settle, mirroring the contract's
// drift tolerance: per-deposit skip conditions, clamping to remaining debt,
// and the per-owner stranding capacity (live non-migrating debt across the
// owner's reviewed deposits minus their live stBTC balance, decremented as
// their deposits settle). `ownerCapacityWei` maps each depositor to that
// capacity and is consumed by the projection. Per-deposit debt is likewise
// consumed across entries, matching the contract's storage decrement, so a
// repeated (depositor, depositId) entry is never double-counted. The fee
// input approximates the fee the contract will accrue at execution time; it
// only matters near the under-collateralization boundary, which the
// contract re-evaluates exactly.
export function projectSettlementOutcome(
  entries: readonly SettlementProjectionInput[],
  ownerCapacityWei: ReadonlyMap<string, bigint>,
): { projected: ProjectedSettlement[]; projectedTotalWei: bigint } {
  const remainingCapacity = new Map(ownerCapacityWei)
  const remainingDeposit = new Map<string, bigint>()
  const projected: ProjectedSettlement[] = []
  let projectedTotalWei = 0n

  entries.forEach((entry) => {
    if (entry.amountWei <= 0n) {
      throw new Error(
        `settlement amount for ${entry.depositor}/${entry.depositId} ` +
          "must be positive",
      )
    }
    const capacity = remainingCapacity.get(entry.depositor)
    if (capacity === undefined) {
      throw new Error(`no owner capacity provided for ${entry.depositor}`)
    }

    const base = {
      depositor: entry.depositor,
      depositId: entry.depositId,
      requestedWei: entry.amountWei,
    }

    if (entry.deposit.balanceWei === 0n) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "DepositNotFound",
      })
      return
    }
    if (entry.deposit.migrating) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "DepositMigrating",
      })
      return
    }

    const depositKey = `${entry.depositor}:${entry.depositId.toString()}`
    const depositDebt =
      remainingDeposit.get(depositKey) ?? entry.deposit.receiptMintedWei
    if (depositDebt === 0n) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "DebtAlreadyRepaid",
      })
      return
    }
    if (
      depositDebt + entry.deposit.projectedFeeWei >
      entry.deposit.balanceWei
    ) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "Undercollateralized",
      })
      return
    }

    let settle = entry.amountWei
    if (settle > depositDebt) {
      settle = depositDebt
    }
    if (settle > capacity) {
      settle = capacity
    }
    if (settle === 0n) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "ReceiptHolderWouldBeStranded",
      })
      return
    }

    remainingDeposit.set(depositKey, depositDebt - settle)
    remainingCapacity.set(entry.depositor, capacity - settle)
    projectedTotalWei += settle
    projected.push({ ...base, projectedWei: settle })
  })

  return { projected, projectedTotalWei }
}

// The exact two-call ProxyAdmin batch: install the recovery implementation
// with the settlement call, then restore the original implementation. Built
// here once so the batch the tests execute and the batch the preflight
// prints for governance cannot drift apart.
export function buildRecoveryBatchPayloads(batch: {
  portal: string
  proxyAdmin: string
  recoveryImplementation: string
  originalImplementation: string
  recoverCalldata: string
}): { targets: string[]; values: bigint[]; payloads: string[] } {
  return {
    targets: [batch.proxyAdmin, batch.proxyAdmin],
    values: [0n, 0n],
    payloads: [
      PROXY_ADMIN_INTERFACE.encodeFunctionData("upgradeAndCall", [
        batch.portal,
        batch.recoveryImplementation,
        batch.recoverCalldata,
      ]),
      PROXY_ADMIN_INTERFACE.encodeFunctionData("upgradeAndCall", [
        batch.portal,
        batch.originalImplementation,
        "0x",
      ]),
    ],
  }
}
