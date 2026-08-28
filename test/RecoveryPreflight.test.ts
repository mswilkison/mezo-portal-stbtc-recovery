import { expect } from "chai"
import {
  hasExactRecoveryAllowance,
  pinnedBlockContext,
  projectSettlementOutcome,
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
        return {
          receiptMintedWei: liveDebt.get(depositId) ?? 0n,
          migrating: false,
        }
      },
    )

    expect(reads).to.deep.equal([19876n, 19877n])
    expect(result.depositIds).to.deep.equal(reads)
    expect(result.totalDebt).to.equal(552_985_988_222_921n)
    // This deliberately differs from the historical manifest aggregate: the
    // result must reflect the callback's live state, not cached snapshot debt.
    expect(result.totalDebt).not.to.equal(120_227_323_759_554_023n)
  })

  it("excludes migrating deposits from repayable debt", async () => {
    const result = await recomputeActiveReceiptDebt(
      ["1", "2"],
      async (depositId) => ({
        receiptMintedWei: 100n,
        migrating: depositId === 2n,
      }),
    )

    // A migrating deposit cannot be repaid through the normal path, so its
    // debt must not count toward the owner's redemption capacity.
    expect(result.totalDebt).to.equal(100n)
  })

  it("rejects incomplete or unsorted active-deposit metadata", async () => {
    const record = async () => ({ receiptMintedWei: 0n, migrating: false })

    await expect(recomputeActiveReceiptDebt([], record)).to.be.rejectedWith(
      "active deposit id list is empty",
    )
    await expect(
      recomputeActiveReceiptDebt(["1", "1"], record),
    ).to.be.rejectedWith("strictly ascending")
    await expect(
      recomputeActiveReceiptDebt(["2", "1"], record),
    ).to.be.rejectedWith("strictly ascending")
  })

  describe("settlement projection", () => {
    const owner = "0xAAA0000000000000000000000000000000000001"
    const healthyDeposit = (receiptMintedWei: bigint, balanceWei: bigint) => ({
      balanceWei,
      receiptMintedWei,
      migrating: false,
      projectedFeeWei: 0n,
    })

    it("settles in full when the owner capacity covers every entry", () => {
      const { projected, projectedTotalWei } = projectSettlementOutcome(
        [
          {
            depositor: owner,
            depositId: 1n,
            amountWei: 700n,
            deposit: healthyDeposit(700n, 1_200n),
          },
          {
            depositor: owner,
            depositId: 2n,
            amountWei: 300n,
            deposit: healthyDeposit(600n, 1_000n),
          },
        ],
        new Map([[owner, 1_200n]]),
      )

      expect(projectedTotalWei).to.equal(1_000n)
      expect(projected.map((entry) => entry.projectedWei)).to.deep.equal([
        700n,
        300n,
      ])
      expect(projected.every((entry) => !entry.skipReason)).to.equal(true)
    })

    it("clamps per owner and reports the stranding skip", () => {
      // Capacity 900: the first entry settles fully, the second clamps to
      // 200, and the third finds no capacity left. The owner's balance is
      // consumed once across the entries, never per entry.
      const { projected, projectedTotalWei } = projectSettlementOutcome(
        [
          {
            depositor: owner,
            depositId: 1n,
            amountWei: 700n,
            deposit: healthyDeposit(700n, 1_200n),
          },
          {
            depositor: owner,
            depositId: 2n,
            amountWei: 300n,
            deposit: healthyDeposit(600n, 1_000n),
          },
          {
            depositor: owner,
            depositId: 3n,
            amountWei: 100n,
            deposit: healthyDeposit(100n, 200n),
          },
        ],
        new Map([[owner, 900n]]),
      )

      expect(projectedTotalWei).to.equal(900n)
      expect(projected[0].projectedWei).to.equal(700n)
      expect(projected[1].projectedWei).to.equal(200n)
      expect(projected[2].projectedWei).to.equal(0n)
      expect(projected[2].skipReason).to.equal("ReceiptHolderWouldBeStranded")
    })

    it("mirrors the contract's per-deposit skip conditions", () => {
      const { projected, projectedTotalWei } = projectSettlementOutcome(
        [
          {
            depositor: owner,
            depositId: 1n,
            amountWei: 100n,
            deposit: healthyDeposit(0n, 0n),
          },
          {
            depositor: owner,
            depositId: 2n,
            amountWei: 100n,
            deposit: { ...healthyDeposit(100n, 200n), migrating: true },
          },
          {
            depositor: owner,
            depositId: 3n,
            amountWei: 100n,
            deposit: healthyDeposit(0n, 200n),
          },
          {
            depositor: owner,
            depositId: 4n,
            amountWei: 100n,
            deposit: {
              balanceWei: 100n,
              receiptMintedWei: 100n,
              migrating: false,
              projectedFeeWei: 1n,
            },
          },
          {
            depositor: owner,
            depositId: 5n,
            amountWei: 150n,
            deposit: healthyDeposit(100n, 200n),
          },
        ],
        new Map([[owner, 1_000n]]),
      )

      expect(projected.map((entry) => entry.skipReason)).to.deep.equal([
        "DepositNotFound",
        "DepositMigrating",
        "DebtAlreadyRepaid",
        "Undercollateralized",
        undefined,
      ])
      // The last entry clamps to its remaining debt.
      expect(projected[4].projectedWei).to.equal(100n)
      expect(projectedTotalWei).to.equal(100n)
    })

    it("rejects malformed projection inputs", () => {
      expect(() =>
        projectSettlementOutcome(
          [
            {
              depositor: owner,
              depositId: 1n,
              amountWei: 0n,
              deposit: healthyDeposit(100n, 200n),
            },
          ],
          new Map([[owner, 100n]]),
        ),
      ).to.throw("must be positive")

      expect(() =>
        projectSettlementOutcome(
          [
            {
              depositor: owner,
              depositId: 1n,
              amountWei: 100n,
              deposit: healthyDeposit(100n, 200n),
            },
          ],
          new Map(),
        ),
      ).to.throw("no owner capacity")
    })
  })
})
