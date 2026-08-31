import { ethers } from "ethers"

export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
export const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
export const ONE_YEAR = 365n * 24n * 60n * 60n
export const FEE_PRECISION = 10n ** 18n

const PROXY_ADMIN_INTERFACE = new ethers.Interface([
  "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
])

export function pinnedBlockContext(blockNumber: number): {
  rpcBlockTag: string
  callOverrides: { blockTag: number }
} {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error(`invalid preflight block number ${blockNumber}`)
  }

  return {
    rpcBlockTag: ethers.toQuantity(blockNumber),
    callOverrides: { blockTag: blockNumber },
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
