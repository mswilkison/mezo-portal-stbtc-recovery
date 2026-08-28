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

// Projects what `recoverTbtc` will actually settle, mirroring the contract's
// drift tolerance: per-deposit skip conditions, clamping to remaining debt,
// and the per-owner stranding capacity (live non-migrating debt across the
// owner's reviewed deposits minus their live stBTC balance, decremented as
// their deposits settle). `ownerCapacityWei` maps each depositor to that
// capacity and is consumed by the projection. The fee input approximates the
// fee the contract will accrue at execution time; it only matters near the
// under-collateralization boundary, which the contract re-evaluates exactly.
export function projectSettlementOutcome(
  entries: readonly SettlementProjectionInput[],
  ownerCapacityWei: ReadonlyMap<string, bigint>,
): { projected: ProjectedSettlement[]; projectedTotalWei: bigint } {
  const remainingCapacity = new Map(ownerCapacityWei)
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
    if (entry.deposit.receiptMintedWei === 0n) {
      projected.push({
        ...base,
        projectedWei: 0n,
        skipReason: "DebtAlreadyRepaid",
      })
      return
    }
    if (
      entry.deposit.receiptMintedWei + entry.deposit.projectedFeeWei >
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
    if (settle > entry.deposit.receiptMintedWei) {
      settle = entry.deposit.receiptMintedWei
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
