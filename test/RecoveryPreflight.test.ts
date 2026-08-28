import { expect } from "chai"
import {
  hasExactRecoveryAllowance,
  pinnedBlockContext,
  recomputeActiveReceiptDebt,
} from "../helpers/recovery-preflight"

describe("recovery preflight helpers", () => {
  it("pins RPC and contract reads to the same block", () => {
    expect(pinnedBlockContext(25_850_299)).to.deep.equal({
      rpcBlockTag: "0x18a71bb",
      callOverrides: { blockTag: 25_850_299 },
    })
    expect(() => pinnedBlockContext(-1)).to.throw(
      "invalid preflight block number",
    )
  })

  it("accepts only the exact recovery allowance", () => {
    const amount = 1_091_038_926_395_006_521n

    expect(hasExactRecoveryAllowance(amount, amount)).to.equal(true)
    expect(hasExactRecoveryAllowance(amount - 1n, amount)).to.equal(false)
    expect(hasExactRecoveryAllowance(amount + 1n, amount)).to.equal(false)
    expect(hasExactRecoveryAllowance(2n ** 256n - 1n, amount)).to.equal(false)
  })

  it("recomputes active debt from every live deposit record", async () => {
    const liveDebt = new Map<bigint, bigint>([
      [19876n, 552_985_988_222_821n],
      [19877n, 100n],
    ])
    const reads: bigint[] = []

    const result = await recomputeActiveReceiptDebt(
      ["19876", "19877"],
      async (depositId) => {
        reads.push(depositId)
        return liveDebt.get(depositId) ?? 0n
      },
    )

    expect(reads).to.deep.equal([19876n, 19877n])
    expect(result.depositIds).to.deep.equal(reads)
    expect(result.totalDebt).to.equal(552_985_988_222_921n)
    // This deliberately differs from the historical manifest aggregate: the
    // result must reflect the callback's live state, not cached snapshot debt.
    expect(result.totalDebt).not.to.equal(120_227_323_759_554_023n)
  })

  it("rejects incomplete active-deposit metadata", async () => {
    await expect(
      recomputeActiveReceiptDebt([], async () => 0n),
    ).to.be.rejectedWith("active deposit id list is empty")
    await expect(
      recomputeActiveReceiptDebt(["1", "1"], async () => 0n),
    ).to.be.rejectedWith("active deposit id list contains duplicates")
  })
})
