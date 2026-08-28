import { ethers } from "ethers"

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

export async function recomputeActiveReceiptDebt(
  depositIds: readonly string[],
  readDebt: (depositId: bigint) => Promise<bigint>,
): Promise<{ depositIds: bigint[]; totalDebt: bigint }> {
  if (depositIds.length === 0) {
    throw new Error("active deposit id list is empty")
  }

  const parsedIds = depositIds.map((depositId) => BigInt(depositId))
  const uniqueIds = new Set(parsedIds.map((depositId) => depositId.toString()))
  if (uniqueIds.size !== parsedIds.length) {
    throw new Error("active deposit id list contains duplicates")
  }

  const debts = await Promise.all(
    parsedIds.map((depositId) => readDebt(depositId)),
  )
  return {
    depositIds: parsedIds,
    totalDebt: debts.reduce((total, debt) => total + debt, 0n),
  }
}
