import { expect } from "chai"
import { Provider, zeroPadValue } from "ethers"
import { readFileSync } from "fs"
import { artifacts } from "hardhat"
import { join } from "path"
import {
  EXTERNAL_STBTC_REVIEW_CONFIRMATION,
  ExternalStbtcReader,
  evaluateExternalStbtcGate,
  getLogsInChunks,
  screenExternalStbtcHoldings,
  verifyPortalSinkIdentity,
} from "../helpers/external-stbtc"
import * as anchors from "../helpers/recovery-anchors"
import {
  RecoveryManifest,
  loadRecoveryManifest,
  validateManifestShape,
} from "../helpers/recovery-manifest"
import {
  annualFeeRatePerSecond,
  assertExactActiveDepositIds,
  assertPinnedBlockHashUnchanged,
  emitRecoveryPreflightResult,
  effectiveFeeIntegralAt,
  exceedsRecoveryReductionTolerance,
  hasExactRecoveryAllowance,
  maximumSettlementFromLiveDebt,
  pinnedBlockContext,
  projectSettlementOutcome,
  projectedFeeOwed,
  recomputeActiveReceiptDebt,
} from "../helpers/recovery-preflight"

describe("recovery preflight helpers", () => {
  it("rejects a malformed manifest before it can be shared", () => {
    const valid = loadRecoveryManifest()
    const malformed = {
      ...valid,
      snapshotBlock: valid.snapshotBlock.toString(),
    } as unknown as RecoveryManifest

    expect(() => validateManifestShape(malformed)).to.throw(
      "snapshotBlock must be a JSON number",
    )
    expect(() => validateManifestShape(valid)).not.to.throw()
    expect(valid.addresses.portalLogicOwner).to.equal(
      anchors.PORTAL_LOGIC_OWNER,
    )
  })

  it("requires a structured, validated manifest dust threshold", () => {
    const valid = loadRecoveryManifest()
    expect(valid.strandingDustWei).to.equal("1000000000000")
    const missing = { ...valid } as Partial<RecoveryManifest>
    delete missing.strandingDustWei

    expect(() => validateManifestShape(missing as RecoveryManifest)).to.throw(
      "strandingDustWei must be a decimal wei string",
    )

    const malformedValues: unknown[] = [
      1000000000000,
      "-1",
      "1e12",
      "0x10",
      "1.5",
      "",
    ]
    malformedValues.forEach((strandingDustWei) => {
      expect(() =>
        validateManifestShape({
          ...valid,
          strandingDustWei,
        } as unknown as RecoveryManifest),
      ).to.throw("strandingDustWei must be a decimal wei string")
    })

    expect(() =>
      validateManifestShape({
        ...valid,
        strandingDustWei: "0",
      } as RecoveryManifest),
    ).not.to.throw()
    expect(() =>
      validateManifestShape({
        ...valid,
        strandingDustWei: "2000000000000",
      } as RecoveryManifest),
    ).not.to.throw()
  })

  it("rejects malformed or duplicated stranding exclusions", () => {
    const valid = loadRecoveryManifest()
    const exclusion = valid.strandingExclusions![0]
    const malformedDebt = {
      ...valid,
      strandingExclusions: [{ ...exclusion, activeDebtWei: "not-wei" }],
    }
    expect(() => validateManifestShape(malformedDebt)).to.throw(
      "strandingExclusions[0].activeDebtWei must be a decimal wei string",
    )

    const emptyIds = {
      ...valid,
      strandingExclusions: [{ ...exclusion, depositIds: [] }],
    }
    expect(() => validateManifestShape(emptyIds)).to.throw(
      "strandingExclusions[0].depositIds must be a non-empty array",
    )

    const duplicate = {
      ...valid,
      strandingExclusions: [exclusion, { ...exclusion }],
    }
    expect(() => validateManifestShape(duplicate)).to.throw(
      "strandingExclusions[1].depositor duplicates another stranding exclusion",
    )
  })

  it("keeps manifest generation independent of the current pin", () => {
    const generatorSource = readFileSync(
      join(__dirname, "..", "scripts", "generate-stbtc-recovery-manifest.ts"),
      "utf8",
    )

    expect(generatorSource).not.to.include("loadRecoveryManifest")
    expect(generatorSource).to.include("anchors.PORTAL_LOGIC_OWNER")
    expect(generatorSource).to.include("strandingDustWei: dustWei.toString()")
  })

  it("derives the reduction gate from the manifest dust threshold", () => {
    const preflightSource = readFileSync(
      join(__dirname, "..", "scripts", "prepare-stbtc-recovery.ts"),
      "utf8",
    )

    expect(preflightSource).to.include("BigInt(manifest.strandingDustWei)")
    expect(preflightSource).not.to.include(
      "1000000000000n * BigInt(ownerReports.length)",
    )
  })

  it("defers execute-stage aborts until cancellation output is built", () => {
    const preflightSource = readFileSync(
      join(__dirname, "..", "scripts", "prepare-stbtc-recovery.ts"),
      "utf8",
    )

    const allowanceGate = preflightSource.indexOf(
      "if (!hasExactRecoveryAllowance",
    )
    const feeProjection = preflightSource.indexOf(
      "const feeState",
      allowanceGate,
    )
    const allowanceBlock = preflightSource.slice(allowanceGate, feeProjection)
    expect(allowanceGate).to.be.greaterThan(-1)
    expect(allowanceBlock).to.include("appendDeferredFailure")
    expect(allowanceBlock).not.to.include("fail(message)")

    const operationGate = preflightSource.indexOf(
      'if (STAGE === "execute" && operationState !== "ready")',
    )
    const governanceBatch = preflightSource.indexOf(
      "output.governanceBatch =",
      operationGate,
    )
    const operationBlock = preflightSource.slice(operationGate, governanceBatch)
    expect(operationGate).to.be.greaterThan(-1)
    expect(operationBlock).to.include("appendDeferredFailure")
    expect(operationBlock).not.to.include("fail(")

    const finalStatus = preflightSource.indexOf(
      "output.preflightPassed =",
      governanceBatch,
    )
    const emission = preflightSource.indexOf(
      "emitRecoveryPreflightResult(",
      governanceBatch,
    )
    expect(governanceBatch).to.be.greaterThan(operationGate)
    expect(finalStatus).to.be.greaterThan(governanceBatch)
    expect(emission).to.be.greaterThan(finalStatus)
  })

  describe("external stBTC holdings gate", () => {
    const depositor = "0x0000000000000000000000000000000000000001"
    const venue = "0x0000000000000000000000000000000000000002"
    const reader = (
      overrides: Partial<ExternalStbtcReader> = {},
    ): ExternalStbtcReader => {
      const result: ExternalStbtcReader = {
        getSentTransfers: async () => [],
        getTotalReceivedWei: async () => 0n,
        getStbtcBalance: async () => 0n,
        getCode: async () => "0x",
        getTokenBalance: async () => 0n,
        getTokenSymbol: async () => "LP",
        resolveKnownDestination: async () => undefined,
        getUniswapV3Positions: async () => [],
        ...overrides,
      }
      if (!overrides.getTotalReceivedWei) {
        result.getTotalReceivedWei = async (address) => {
          const [sent, balance] = await Promise.all([
            result.getSentTransfers(address),
            result.getStbtcBalance(address),
          ])
          return (
            sent.reduce((total, transfer) => total + transfer.amountWei, 0n) +
            balance
          )
        }
      }
      return result
    }

    it("requires the non-enumerable positions to be reviewed manually", async () => {
      const report = await screenExternalStbtcHoldings([depositor], reader())

      // An empty destination scan is not proof: an LP token could have been
      // received from a third party, staked, or held at a related address.
      expect(evaluateExternalStbtcGate(report, undefined).passed).to.equal(
        false,
      )
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
    })

    it("blocks when Transfer history does not reconcile to the pinned balance", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [{ destination: venue, amountWei: 4n }],
          getTotalReceivedWei: async () => 10n,
          getStbtcBalance: async (address) =>
            address.toLowerCase() === depositor.toLowerCase() ? 5n : 0n,
        }),
      )

      expect(report.depositors[0].totalSentWei).to.equal(4n)
      expect(report.unverifiableReasons[0]).to.include(
        "Transfer history does not reconcile",
      )
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
    })

    it("ignores permissionless zero-value transfer destinations", async () => {
      let shareBalanceCalls = 0
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [{ destination: venue, amountWei: 0n }],
          getCode: async () => "0x01",
          getTokenBalance: async () => {
            shareBalanceCalls += 1
            throw new Error("balanceOf reverted")
          },
        }),
      )

      expect(shareBalanceCalls).to.equal(0)
      expect(report.depositors[0].totalSentWei).to.equal(0n)
      expect(report.depositors[0].destinations).to.deep.equal([])
      expect(report.unverifiableReasons).to.deep.equal([])
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
    })

    it("accepts the reviewed Portal as a non-claim sink", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [
            { destination: anchors.PORTAL, amountWei: 1n },
          ],
          getCode: async () => "0x01",
          getTokenBalance: async () => {
            throw new Error("Portal has no ERC-20 balanceOf")
          },
          resolveKnownDestination: async () => ({
            adapter: "portal-sink",
            status: "noClaim",
            evidence: "reviewed implementation",
          }),
        }),
      )

      expect(report.unverifiableReasons).to.deep.equal([])
      expect(report.depositors[0].destinations[0].adapter).to.equal(
        "portal-sink",
      )
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
    })

    it("preserves a nonzero claim when token metadata reverts", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [
            { destination: venue, amountWei: 10n },
          ],
          getCode: async () => "0x01",
          // A strategy-backed share token may itself custody no stBTC.
          getStbtcBalance: async () => 0n,
          getTokenBalance: async () => 7n,
          getTokenSymbol: async () => {
            throw new Error("non-standard symbol")
          },
        }),
      )

      expect(
        report.depositors[0].destinations[0].depositorClaimBalanceWei,
      ).to.equal(7n)
      expect(report.depositors[0].destinations[0].symbol).to.equal(undefined)
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
    })

    it("fails closed on an unreadable unknown venue even at one wei", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [
            { destination: venue, amountWei: 10n },
          ],
          getCode: async () => "0x01",
          getStbtcBalance: async (address) =>
            address.toLowerCase() === venue.toLowerCase() ? 1n : 0n,
          getTokenBalance: async () => {
            throw new Error("balanceOf reverted")
          },
        }),
      )

      expect(report.depositors[0].destinations[0].claimBalanceError).to.equal(
        "balanceOf reverted",
      )
      expect(evaluateExternalStbtcGate(report, undefined).passed).to.equal(
        false,
      )
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
    })

    it("does not turn a directly held balance into a process veto", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({ getStbtcBalance: async () => 1n }),
      )

      // The recovery contract reads this balance atomically and clamps the
      // owner's settlement; only positions outside that wallet need this
      // process-level gate.
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
      expect(report.depositors[0].walletBalanceWei).to.equal(1n)
    })

    it("accepts an exact typed router resolution without treating dust as a share token", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [
            { destination: venue, amountWei: 10n },
          ],
          getCode: async () => "0x01",
          getStbtcBalance: async (address) =>
            address.toLowerCase() === venue.toLowerCase() ? 1n : 0n,
          getTokenBalance: async () => {
            throw new Error("must not call ERC20 balanceOf for typed router")
          },
          resolveKnownDestination: async () => ({
            adapter: "curve-router-v1.1",
            status: "noClaim",
            evidence: "reconciled swap",
          }),
        }),
      )

      expect(report.unverifiableReasons).to.deep.equal([])
      expect(report.depositors[0].destinations[0].resolution).to.equal(
        "noClaim",
      )
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
    })

    it("keeps a failed typed adapter blocking even with attestation", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [{ destination: venue, amountWei: 1n }],
          getCode: async () => "0x01",
          getStbtcBalance: async (address) =>
            address.toLowerCase() === venue.toLowerCase() ? 1n : 0n,
          resolveKnownDestination: async () => ({
            adapter: "curve-router-v1.1",
            status: "unresolved",
            evidence: "runtime hash mismatch",
          }),
        }),
      )

      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
      expect(report.unverifiableReasons[0]).to.include("runtime hash mismatch")
    })

    it("does not reclassify a known protocol as an EOA after code drift", async () => {
      let adapterCalled = false
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getSentTransfers: async () => [
            { destination: venue, amountWei: 10n },
          ],
          getCode: async () => "0x",
          getStbtcBalance: async () => 0n,
          resolveKnownDestination: async () => {
            adapterCalled = true
            return {
              adapter: "curve-router-v1.1",
              status: "unresolved",
              evidence: "router output was not tBTC",
            }
          },
        }),
      )

      expect(adapterCalled).to.equal(true)
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
    })

    it("blocks a live canonical Uniswap V3 stBTC position", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getUniswapV3Positions: async () => [
            {
              adapter: "uniswap-v3-nft",
              tokenId: 796823n,
              owner: depositor,
              token0: "0x0000000000000000000000000000000000000003",
              token1: "0x0000000000000000000000000000000000000004",
              fee: 10000,
              liquidity: 1n,
              tokensOwed0: 0n,
              tokensOwed1: 0n,
            },
          ],
        }),
      )

      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
      expect(report.detectedClaimReasons[0]).to.include("NFT 796823")
    })

    it("blocks a direct Uniswap V3 core position with no NFT", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getUniswapV3Positions: async () => [
            {
              adapter: "uniswap-v3-core",
              owner: depositor,
              tickLower: -200,
              tickUpper: 200,
              liquidity: 1n,
              tokensOwed0: 0n,
              tokensOwed1: 0n,
            },
          ],
        }),
      )

      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
      expect(report.detectedClaimReasons[0]).to.include("core range -200/200")
    })

    it("accepts a fully collected canonical Uniswap V3 stBTC position", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getUniswapV3Positions: async () => [
            {
              adapter: "uniswap-v3-nft",
              tokenId: 796823n,
              owner: depositor,
              token0: "0x0000000000000000000000000000000000000003",
              token1: "0x0000000000000000000000000000000000000004",
              fee: 10000,
              liquidity: 0n,
              tokensOwed0: 0n,
              tokensOwed1: 0n,
            },
          ],
        }),
      )

      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(true)
    })

    it("fails closed when canonical position enumeration fails", async () => {
      const report = await screenExternalStbtcHoldings(
        [depositor],
        reader({
          getUniswapV3Positions: async () => {
            throw new Error("position manager code drift")
          },
        }),
      )

      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
      expect(report.unverifiableReasons[0]).to.include(
        "position manager code drift",
      )
    })

    it("adapts capped archive log ranges without gaps", async () => {
      const successfulRanges: number[][] = []
      let rejectedWideRange = false
      const provider = {
        getLogs: async (filter: { fromBlock?: number; toBlock?: number }) => {
          const fromBlock = Number(filter.fromBlock)
          const toBlock = Number(filter.toBlock)
          if (toBlock - fromBlock + 1 > 3) {
            rejectedWideRange = true
            throw new Error("range capped")
          }
          successfulRanges.push([fromBlock, toBlock])
          return []
        },
      } as unknown as Provider

      expect(await getLogsInChunks(provider, {}, 1, 10, 8, 1)).to.deep.equal([])
      expect(rejectedWideRange).to.equal(true)
      expect(successfulRanges).to.deep.equal([
        [1, 2],
        [3, 4],
        [5, 6],
        [7, 8],
        [9, 10],
      ])
    })

    it("pins the Portal sink to the reviewed implementation", async () => {
      const portalArtifact = await artifacts.readArtifact("Portal")
      const provider = {
        getStorage: async () =>
          zeroPadValue(anchors.ORIGINAL_IMPLEMENTATION, 32),
        getCode: async (address: string) =>
          address.toLowerCase() === anchors.PORTAL.toLowerCase()
            ? "0x01"
            : portalArtifact.deployedBytecode,
      } as unknown as Provider

      expect(await verifyPortalSinkIdentity(provider, 25_850_299)).to.equal(
        anchors.ORIGINAL_IMPLEMENTATION,
      )

      const driftedProvider = {
        ...provider,
        getStorage: async () =>
          zeroPadValue("0x0000000000000000000000000000000000000001", 32),
      } as unknown as Provider
      await expect(
        verifyPortalSinkIdentity(driftedProvider, 25_850_299),
      ).to.be.rejectedWith("does not match reviewed")
    })
  })

  it("pins snapshot reads to the resolved block hash", () => {
    const blockHash = `0x${"11".repeat(32)}`
    expect(pinnedBlockContext(25_850_299, blockHash)).to.deep.equal({
      rpcBlockTag: { blockHash, requireCanonical: true },
      callOverrides: { blockTag: blockHash },
    })
    expect(() => pinnedBlockContext(-1, blockHash)).to.throw(
      "invalid preflight block number",
    )
    expect(() => pinnedBlockContext(25_850_299, null)).to.throw(
      "invalid preflight block hash",
    )
    expect(() => pinnedBlockContext(25_850_299, "0x1234")).to.throw(
      "invalid preflight block hash",
    )
  })

  it("accepts a pinned height whose canonical hash is unchanged", async () => {
    const blockHash = `0x${"11".repeat(32)}`
    const provider = {
      getBlock: async (blockNumber: number) => ({
        number: blockNumber,
        hash: blockHash,
      }),
    }

    await expect(
      assertPinnedBlockHashUnchanged(provider, 25_850_299, blockHash),
    ).not.to.be.rejected
  })

  it("rejects a reorg of the pinned height", async () => {
    const initialHash = `0x${"11".repeat(32)}`
    const replacementHash = `0x${"22".repeat(32)}`
    const provider = {
      getBlock: async (blockNumber: number) => ({
        number: blockNumber,
        hash: replacementHash,
      }),
    }

    await expect(
      assertPinnedBlockHashUnchanged(provider, 25_850_299, initialHash),
    ).to.be.rejectedWith(
      "pinned block 25850299 was reorged during the scan: started at " +
        `${initialHash}, now canonical at ${replacementHash}`,
    )
  })

  it("fails closed when canonical block identity cannot be revalidated", async () => {
    const initialHash = `0x${"11".repeat(32)}`
    const missingProvider = {
      getBlock: async () => null,
    }

    await expect(
      assertPinnedBlockHashUnchanged(missingProvider, 25_850_299, initialHash),
    ).to.be.rejectedWith("could not be re-fetched with a canonical hash")
    await expect(
      assertPinnedBlockHashUnchanged(missingProvider, 25_850_299, null),
    ).to.be.rejectedWith("pinned block 25850299 has no hash")
  })

  it("rechecks every number-pinned workflow before accepting its output", () => {
    const preflightSource = readFileSync(
      join(__dirname, "..", "scripts", "prepare-stbtc-recovery.ts"),
      "utf8",
    )
    const recheck = preflightSource.lastIndexOf(
      "await assertPinnedBlockHashUnchanged",
    )
    const finalStatus = preflightSource.indexOf(
      "output.preflightPassed =",
      recheck,
    )
    const emission = preflightSource.indexOf(
      "emitRecoveryPreflightResult(",
      finalStatus,
    )

    expect(recheck).to.be.greaterThan(-1)
    expect(finalStatus).to.be.greaterThan(recheck)
    expect(emission).to.be.greaterThan(finalStatus)
    expect(preflightSource.slice(recheck, finalStatus)).to.include(
      "appendDeferredFailure",
    )

    ;[
      ["check-external-stbtc.ts", "const gate = evaluateExternalStbtcGate"],
      ["generate-stbtc-recovery-manifest.ts", "writeFileSync(outPath"],
    ].forEach(([script, acceptanceMarker]) => {
      const source = readFileSync(
        join(__dirname, "..", "scripts", script),
        "utf8",
      )
      const scriptRecheck = source.lastIndexOf(
        "await assertPinnedBlockHashUnchanged",
      )
      expect(scriptRecheck).to.be.greaterThan(-1)
      expect(source.indexOf(acceptanceMarker, scriptRecheck)).to.be.greaterThan(
        scriptRecheck,
      )
    })
  })

  it("accepts only the exact recovery allowance", () => {
    const amount = 1_091_038_926_395_006_521n

    expect(hasExactRecoveryAllowance(amount, amount)).to.equal(true)
    expect(hasExactRecoveryAllowance(amount - 1n, amount)).to.equal(false)
    expect(hasExactRecoveryAllowance(amount + 1n, amount)).to.equal(false)
    expect(hasExactRecoveryAllowance(2n ** 256n - 1n, amount)).to.equal(false)
  })

  it("uses the manifest dust threshold for reduced-recovery acceptance", () => {
    const defaultDust = 1000000000000n

    expect(
      exceedsRecoveryReductionTolerance(defaultDust, defaultDust, 1),
    ).to.equal(false)
    expect(
      exceedsRecoveryReductionTolerance(defaultDust + 1n, defaultDust, 1),
    ).to.equal(true)

    // A lower custom policy must not inherit the old 1e12-wei bypass window.
    expect(exceedsRecoveryReductionTolerance(6n, 5n, 1)).to.equal(true)
    // A higher custom policy must continue to tolerate its approved dust.
    expect(
      exceedsRecoveryReductionTolerance(defaultDust + 1n, 2n * defaultDust, 1),
    ).to.equal(false)

    expect(exceedsRecoveryReductionTolerance(0n, 0n, 1)).to.equal(false)
    expect(exceedsRecoveryReductionTolerance(1n, 0n, 1)).to.equal(true)
    expect(exceedsRecoveryReductionTolerance(30n, 10n, 3)).to.equal(false)
    expect(exceedsRecoveryReductionTolerance(31n, 10n, 3)).to.equal(true)

    expect(() => exceedsRecoveryReductionTolerance(-1n, 0n, 1)).to.throw(
      "projected recovery residual must be non-negative",
    )
    expect(() => exceedsRecoveryReductionTolerance(0n, -1n, 1)).to.throw(
      "stranding dust threshold must be non-negative",
    )
    expect(() => exceedsRecoveryReductionTolerance(0n, 0n, -1)).to.throw(
      "selected owner count must be a non-negative safe integer",
    )
    expect(() => exceedsRecoveryReductionTolerance(0n, 0n, 1.5)).to.throw(
      "selected owner count must be a non-negative safe integer",
    )
  })

  it("bounds funding and debt sufficiency by live selected debt", () => {
    const owner = "0xAAA0000000000000000000000000000000000001"
    const entry = (depositId: bigint, amountWei: bigint, debtWei: bigint) => ({
      depositor: owner,
      depositId,
      amountWei,
      deposit: {
        balanceWei: 1_000n,
        receiptMintedWei: debtWei,
        migrating: false,
        projectedFeeWei: 0n,
      },
    })

    // A 1-wei repayment lowers the valid round from 100 to 99. Global receipt
    // debt of 99 is sufficient for what the contract can still settle and
    // must not be compared with the stale 100-wei manifest total.
    expect(maximumSettlementFromLiveDebt([entry(1n, 100n, 99n)])).to.equal(99n)

    // A fully repaid and withdrawn entry is permanently skipped. It must not
    // keep token funding pinned to the stale manifest total, while a live
    // entry remains fully covered even if its padded fee projection may skip.
    const withdrawn = entry(2n, 100n, 0n)
    withdrawn.deposit.balanceWei = 0n
    const live = entry(3n, 100n, 100n)
    live.deposit.projectedFeeWei = 1_000n
    expect(maximumSettlementFromLiveDebt([withdrawn, live])).to.equal(100n)

    const migrating = entry(4n, 100n, 100n)
    migrating.deposit.migrating = true
    expect(maximumSettlementFromLiveDebt([migrating, live])).to.equal(100n)

    // The upper bound consumes repeated keys exactly once even though the
    // mandatory manifest validation rejects duplicates independently.
    expect(
      maximumSettlementFromLiveDebt([
        entry(2n, 75n, 100n),
        entry(2n, 75n, 100n),
      ]),
    ).to.equal(100n)
  })

  it("emits governance output before a deferred execution failure", () => {
    const emitted: string[] = []

    expect(() =>
      emitRecoveryPreflightResult(
        '{"preflightPassed":false,"governanceBatch":{"cancelTransaction":"0x1234"}}',
        "cancel the reduced operation",
        (output) => emitted.push(output),
      ),
    ).to.throw("Recovery preflight failed: cancel the reduced operation")
    expect(emitted).to.deep.equal([
      '{"preflightPassed":false,"governanceBatch":{"cancelTransaction":"0x1234"}}',
    ])
    expect(JSON.parse(emitted[0])).to.deep.equal({
      preflightPassed: false,
      governanceBatch: { cancelTransaction: "0x1234" },
    })

    expect(() =>
      emitRecoveryPreflightResult("ready", undefined, (output) =>
        emitted.push(output),
      ),
    ).not.to.throw()
    expect(emitted[1]).to.equal("ready")
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

  it("mirrors the Portal's lazy fee accounting", () => {
    // Independently derived from the Portal source: feePerSecond =
    // annualFee * 1e16 / 365 days (integer division), integral grows
    // linearly, and accrued fee = integralDiff * minted / 1e18.
    expect(annualFeeRatePerSecond(2n)).to.equal(
      (2n * 10n ** 16n) / (365n * 24n * 60n * 60n),
    )

    const fee = {
      feeIntegral: 1_000n,
      lastFeeUpdateAt: 1_700_000_000n,
      annualFee: 2n,
    }
    const later = 1_700_000_000n + 2_592_000n // 30 days
    const expectedIntegral = 1_000n + 2_592_000n * annualFeeRatePerSecond(2n)
    expect(effectiveFeeIntegralAt(fee, later)).to.equal(expectedIntegral)
    expect(effectiveFeeIntegralAt(fee, fee.lastFeeUpdateAt)).to.equal(1_000n)

    const deposit = {
      feeOwedWei: 7n,
      lastFeeIntegral: 1_000n,
      receiptMintedWei: 10n ** 18n,
    }
    expect(projectedFeeOwed(deposit, expectedIntegral)).to.equal(
      7n + (expectedIntegral - 1_000n),
    )
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

  it("rejects a truncated exclusion deposit-id list", () => {
    expect(() =>
      assertExactActiveDepositIds("excluded owner", [1n], [1n, 2n]),
    ).to.throw(
      "excluded owner active deposit ids do not match Portal history: " +
        "reviewed [1], live [1, 2]",
    )
    expect(() =>
      assertExactActiveDepositIds("excluded owner", [1n, 2n], [1n, 2n]),
    ).not.to.throw()
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

    it("consumes per-deposit debt across repeated entries", () => {
      // A duplicated (depositor, depositId) settles once on-chain — the
      // second entry clamps against the storage the first already
      // decremented. The projection must mirror that, not double-count the
      // static snapshot: two 75-wei requests against 100 wei of debt with
      // ample owner capacity execute 100, never 150.
      const { projected, projectedTotalWei } = projectSettlementOutcome(
        [
          {
            depositor: owner,
            depositId: 7n,
            amountWei: 75n,
            deposit: healthyDeposit(100n, 300n),
          },
          {
            depositor: owner,
            depositId: 7n,
            amountWei: 75n,
            deposit: healthyDeposit(100n, 300n),
          },
        ],
        new Map([[owner, 1_000n]]),
      )

      expect(projected[0].projectedWei).to.equal(75n)
      expect(projected[1].projectedWei).to.equal(25n)
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
