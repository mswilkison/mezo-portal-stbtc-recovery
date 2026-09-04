import { expect } from "chai"
import {
  Filter,
  Interface,
  Log,
  Provider,
  getAddress,
  id,
  toBeHex,
  zeroPadValue,
} from "ethers"
import { readFileSync } from "fs"
import { artifacts } from "hardhat"
import { join } from "path"
import {
  EXTERNAL_STBTC_REVIEW_CONFIRMATION,
  ExternalStbtcReader,
  UniswapV3CoreReader,
  UniswapV3PoolIdentity,
  createExternalStbtcLogHistory,
  enumerateDirectCorePositions,
  evaluateExternalStbtcGate,
  extendExternalStbtcLogHistory,
  getLogsInChunks,
  screenExternalStbtcHoldings,
  verifyPortalSinkIdentity,
} from "../helpers/external-stbtc"
import * as anchors from "../helpers/recovery-anchors"
import {
  RecoveryManifest,
  assertManifestSnapshotCanonical,
  loadRecoveryManifest,
  validateManifestShape,
} from "../helpers/recovery-manifest"
import {
  annualFeeRatePerSecond,
  assertExactActiveDepositIds,
  assertPinnedBlockHashUnchanged,
  assertStillLatestBlock,
  emitRecoveryPreflightResult,
  effectiveFeeIntegralAt,
  evaluateAtConvergedLatest,
  exceedsRecoveryReductionTolerance,
  hasExactRecoveryAllowance,
  maximumSettlementFromLiveDebt,
  pinnedBlockContext,
  projectSettlementOutcome,
  projectedFeeOwed,
  readLiveSettlementOwners,
  recomputeActiveReceiptDebt,
} from "../helpers/recovery-preflight"
import withExternalStbtcHistory from "./fixtures/externalStbtcHistory"

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

  it("requires a well-formed snapshot block hash", () => {
    const valid = loadRecoveryManifest()
    const missing = { ...valid } as Partial<RecoveryManifest>
    delete missing.snapshotBlockHash

    expect(() => validateManifestShape(missing as RecoveryManifest)).to.throw(
      "snapshotBlockHash must be a 32-byte hex string",
    )

    const malformedValues: unknown[] = [
      null,
      123,
      "",
      "0x1234",
      `0x${"11".repeat(31)}`,
      `0x${"11".repeat(33)}`,
      `0x${"gg".repeat(32)}`,
    ]
    malformedValues.forEach((snapshotBlockHash) => {
      expect(() =>
        validateManifestShape({
          ...valid,
          snapshotBlockHash,
        } as unknown as RecoveryManifest),
      ).to.throw("snapshotBlockHash must be a 32-byte hex string")
    })

    expect(() =>
      validateManifestShape({
        ...valid,
        snapshotBlockHash: `0x${"AB".repeat(32)}`,
      }),
    ).not.to.throw()
  })

  it("rejects a manifest whose generating block was replaced", async () => {
    const valid = loadRecoveryManifest()
    const replacementHash = `0x${"22".repeat(32)}`
    const canonicalProvider = {
      getBlock: async (blockNumber: number) => ({
        number: blockNumber,
        hash: valid.snapshotBlockHash.toUpperCase(),
      }),
    }
    const replacementProvider = {
      getBlock: async (blockNumber: number) => ({
        number: blockNumber,
        hash: replacementHash,
      }),
    }
    let transitionReads = 0
    const transitioningProvider = {
      getBlock: async (blockNumber: number) => {
        const hash =
          transitionReads === 0 ? valid.snapshotBlockHash : replacementHash
        transitionReads += 1
        return { number: blockNumber, hash }
      },
    }

    await expect(assertManifestSnapshotCanonical(canonicalProvider, valid)).not
      .to.be.rejected
    await expect(
      assertManifestSnapshotCanonical(replacementProvider, valid),
    ).to.be.rejectedWith(
      `manifest snapshot block ${valid.snapshotBlock} hash mismatch: ` +
        `expected ${valid.snapshotBlockHash}, canonical ${replacementHash}`,
    )
    await expect(assertManifestSnapshotCanonical(transitioningProvider, valid))
      .not.to.be.rejected
    await expect(
      assertManifestSnapshotCanonical(transitioningProvider, valid),
    ).to.be.rejectedWith("hash mismatch")
    await expect(
      assertManifestSnapshotCanonical({ getBlock: async () => null }, valid),
    ).to.be.rejectedWith("could not be resolved with a canonical hash")
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

  it("rejects settlement active-deposit ids that are not decimal strings", () => {
    const valid = loadRecoveryManifest()
    const settlement = valid.settlements[0]
    // BigInt() would coerce "" to 0 and accept hex, so calldata could carry
    // an id governance never reviewed; hold these to the exclusion-list rule.
    const malformedIds: unknown[] = ["", " 77", "0x4d", "77.0", "-1", 77]
    malformedIds.forEach((depositId) => {
      expect(() =>
        validateManifestShape({
          ...valid,
          settlements: [
            {
              ...settlement,
              depositorActiveDepositIds: [depositId, settlement.depositId],
            },
          ],
        } as unknown as RecoveryManifest),
      ).to.throw(
        "settlements[0].depositorActiveDepositIds[0] must be a decimal wei string",
      )
    })
    expect(() =>
      validateManifestShape({
        ...valid,
        settlements: [{ ...settlement, depositor: 42 }],
      } as unknown as RecoveryManifest),
    ).to.throw("settlements[0].depositor must be a string")
    expect(() => validateManifestShape(valid)).not.to.throw()
  })

  it("keeps manifest generation independent of the current pin", () => {
    const generatorSource = readFileSync(
      join(__dirname, "..", "scripts", "generate-stbtc-recovery-manifest.ts"),
      "utf8",
    )

    expect(generatorSource).not.to.include("loadRecoveryManifest")
    expect(generatorSource).to.include("anchors.PORTAL_LOGIC_OWNER")
    expect(generatorSource).to.include("strandingDustWei: dustWei.toString()")
    expect(generatorSource).to.include("snapshotBlockHash: block.hash")
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

    // Funding/receipt-debt sufficiency and the deployed-implementation
    // verification run after deferred failures may already be recorded and
    // before the output is emitted, so they must defer too — otherwise a
    // scheduled batch whose funding or implementation moved would abort
    // with a bare stack trace and no cancel calldata.
    const sufficiencyGate = preflightSource.indexOf(
      "const sufficiencyProblems: string[] = []",
    )
    const driftReport = preflightSource.indexOf(
      "if (driftMessages.length > 0)",
      sufficiencyGate,
    )
    const sufficiencyBlock = preflightSource.slice(sufficiencyGate, driftReport)
    expect(sufficiencyGate).to.be.greaterThan(allowanceGate)
    expect(driftReport).to.be.greaterThan(sufficiencyGate)
    expect(sufficiencyBlock).to.include("appendDeferredFailure")
    expect(sufficiencyBlock).not.to.include("fail(")

    const deployedVerification = preflightSource.indexOf(
      "const recoveryProblems: string[] = []",
    )
    const deployedBlock = preflightSource.slice(
      deployedVerification,
      operationGate,
    )
    expect(deployedVerification).to.be.greaterThan(sufficiencyGate)
    expect(deployedVerification).to.be.lessThan(operationGate)
    expect(deployedBlock).to.include("appendDeferredFailure")
    expect(deployedBlock).to.include("verifyRecoveryBytecode(")
    expect(deployedBlock).not.to.include("fail(")

    // The execute stage must demand RECOVERY_IMPLEMENTATION before the
    // deployment-to-head archive scan, not after it.
    const implementationGuard = preflightSource.indexOf(
      "RECOVERY_STAGE=execute requires RECOVERY_IMPLEMENTATION",
    )
    expect(implementationGuard).to.be.greaterThan(-1)
    expect(implementationGuard).to.be.lessThan(
      preflightSource.indexOf("await evaluateAtConvergedLatest"),
    )

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

    ;[
      {
        state: "repaid",
        balanceWei: 100n,
        receiptMintedWei: 0n,
        migrating: false,
      },
      {
        state: "withdrawn",
        balanceWei: 0n,
        receiptMintedWei: 0n,
        migrating: false,
      },
      {
        state: "migrating",
        balanceWei: 100n,
        receiptMintedWei: 100n,
        migrating: true,
      },
    ].forEach(({ state, ...inactiveDeposit }) => {
      it(`does not gate the remaining round on a ${state} owner's external holdings`, async () => {
        const activeOwner = "0x0000000000000000000000000000000000000003"
        const entries = [depositor, activeOwner].map((owner) => ({
          depositor: owner,
          depositId: 1n,
          amountWei: 100n,
        }))
        const owners = await readLiveSettlementOwners(entries, async (owner) =>
          owner === depositor
            ? inactiveDeposit
            : {
                balanceWei: 100n,
                receiptMintedWei: 100n,
                migrating: false,
              },
        )
        expect(owners).to.deep.equal([activeOwner])
        const checkedOwners: string[] = []
        const report = await screenExternalStbtcHoldings(
          owners,
          reader({
            getUniswapV3Positions: async (owner) => {
              checkedOwners.push(owner)
              if (owner === depositor) {
                throw new Error("retired owner's venue is unreadable")
              }
              return []
            },
          }),
        )
        expect(checkedOwners).to.deep.equal([activeOwner])
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(true)
      })
    })

    it("keeps mixed-deposit owners in scope despite zero fee or wallet-capacity projections", async () => {
      const entries = [1n, 2n].map((depositId) => ({
        depositor,
        depositId,
        amountWei: 100n,
        deposit: {
          balanceWei: 100n,
          receiptMintedWei: depositId === 1n ? 0n : 100n,
          migrating: false,
          projectedFeeWei: 10n,
        },
      }))
      expect(
        projectSettlementOutcome(entries, new Map([[depositor, 100n]]))
          .projectedTotalWei,
      ).to.equal(0n)
      expect(
        projectSettlementOutcome(
          entries.map((entry) => ({
            ...entry,
            deposit: { ...entry.deposit, projectedFeeWei: 0n },
          })),
          new Map([[depositor, 0n]]),
        ).projectedTotalWei,
      ).to.equal(0n)
      const owners = await readLiveSettlementOwners(
        entries,
        async (_, depositId) => entries[Number(depositId) - 1].deposit,
      )
      expect(owners).to.deep.equal([depositor])
      const report = await screenExternalStbtcHoldings(
        owners,
        reader({
          getSentTransfers: async () => [{ destination: venue, amountWei: 1n }],
          getCode: async () => "0x01",
          getTokenBalance: async () => 7n,
        }),
      )
      expect(report.detectedClaimReasons).to.have.length(1)
      expect(
        evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
          .passed,
      ).to.equal(false)
    })

    it("recomputes live owner scope at each convergence candidate", async () => {
      const activeOwner = "0x0000000000000000000000000000000000000003"
      const entries = [depositor, activeOwner].map((owner) => ({
        depositor: owner,
        depositId: 1n,
        amountWei: 100n,
      }))
      const block = (number: number) => ({
        number,
        hash: `0x${number.toString(16).padStart(64, "0")}`,
      })
      let latestReads = 0
      const provider = {
        getBlock: async (tag: number | "latest") => {
          if (tag !== "latest") {
            return block(tag)
          }
          latestReads += 1
          return block(latestReads === 1 ? 10 : 12)
        },
      }
      const evaluated: { hash: string; owners: string[] }[] = []
      const converged = await evaluateAtConvergedLatest(
        provider,
        async (candidate) => {
          const { callOverrides } = pinnedBlockContext(
            candidate.number,
            candidate.hash,
          )
          const owners = await readLiveSettlementOwners(
            entries,
            async (owner) => ({
              balanceWei: 100n,
              receiptMintedWei:
                owner === depositor && callOverrides.blockTag === block(12).hash
                  ? 0n
                  : 100n,
              migrating: false,
            }),
          )
          evaluated.push({ hash: callOverrides.blockTag, owners })
          return screenExternalStbtcHoldings(
            owners,
            reader({
              getUniswapV3Positions: async (owner) => {
                if (owner === depositor) {
                  throw new Error("venue is unreadable")
                }
                return []
              },
            }),
          )
        },
      )
      expect(evaluated).to.deep.equal([
        { hash: block(10).hash, owners: [depositor, activeOwner] },
        { hash: block(12).hash, owners: [activeOwner] },
      ])
      expect(
        evaluateExternalStbtcGate(
          converged.result,
          EXTERNAL_STBTC_REVIEW_CONFIRMATION,
        ).passed,
      ).to.equal(true)
    })

    it("does not exclude an owner whose selected debt cannot be read", async () => {
      await expect(
        readLiveSettlementOwners(
          [{ depositor, depositId: 1n, amountWei: 100n }],
          async () => {
            throw new Error("deposit read unavailable")
          },
        ),
      ).to.be.rejectedWith("deposit read unavailable")
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

    describe("wallet self-transfers", () => {
      const wallet = getAddress("0x00000000000000000000000000000000000000aa")
      const selfTransfers = [
        { destination: wallet.toLowerCase(), amountWei: 4n },
        { destination: wallet, amountWei: 6n },
      ]
      const walletReader = (overrides: Partial<ExternalStbtcReader> = {}) =>
        reader({
          getSentTransfers: async () => selfTransfers,
          getTotalReceivedWei: async () => 13n,
          getStbtcBalance: async (address) =>
            getAddress(address) === wallet ? 3n : 0n,
          getCode: async () => "0x01",
          getTokenBalance: async () => {
            throw new Error("wallet does not implement balanceOf")
          },
          ...overrides,
        })

      it("reconciles self-transfers without probing the contract wallet as a venue", async () => {
        const probedAddresses: string[] = []
        let positionReads = 0
        const report = await screenExternalStbtcHoldings(
          [wallet.toLowerCase()],
          walletReader({
            getCode: async (address) => {
              probedAddresses.push(address)
              return "0x01"
            },
            getUniswapV3Positions: async () => {
              positionReads += 1
              return []
            },
          }),
        )
        expect(report.depositors[0]).to.include({
          depositor: wallet,
          totalReceivedWei: 13n,
          totalSentWei: 10n,
          walletBalanceWei: 3n,
        })
        expect(report.depositors[0].destinations).to.deep.equal([])
        expect(probedAddresses).to.deep.equal([])
        expect(positionReads).to.equal(1)
        expect(report.unverifiableReasons).to.deep.equal([])
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(true)
        expect(evaluateExternalStbtcGate(report, undefined).passed).to.equal(
          false,
        )
      })

      ;["claim", "unreadable"].forEach((state) => {
        it(`keeps a genuine external venue ${state} blocking alongside self-transfers`, async () => {
          const probedTokens: string[] = []
          const report = await screenExternalStbtcHoldings(
            [wallet],
            walletReader({
              getSentTransfers: async () => [
                ...selfTransfers,
                { destination: venue, amountWei: 1n },
                { destination: venue, amountWei: 3n },
              ],
              getTotalReceivedWei: async () => 17n,
              getTokenBalance: async (token, holder) => {
                probedTokens.push(token)
                expect(holder).to.equal(wallet)
                if (state === "unreadable") {
                  throw new Error("external balance unavailable")
                }
                return 7n
              },
            }),
          )
          expect(report.depositors[0].totalSentWei).to.equal(14n)
          expect(report.depositors[0].destinations).to.have.length(1)
          expect(report.depositors[0].destinations[0]).to.include({
            destination: venue,
            amountSentWei: 4n,
          })
          expect(probedTokens).to.deep.equal([venue])
          expect(report.detectedClaimReasons).to.have.length(
            state === "claim" ? 1 : 0,
          )
          expect(report.unverifiableReasons).to.have.length(
            state === "unreadable" ? 1 : 0,
          )
          expect(
            evaluateExternalStbtcGate(
              report,
              EXTERNAL_STBTC_REVIEW_CONFIRMATION,
            ).passed,
          ).to.equal(false)
        })
      })

      it("keeps self-transfer reconciliation failures blocking", async () => {
        const report = await screenExternalStbtcHoldings(
          [wallet],
          walletReader({
            getTotalReceivedWei: async () => 12n,
          }),
        )
        expect(report.depositors[0].destinations).to.deep.equal([])
        expect(report.unverifiableReasons).to.have.length(1)
        expect(report.unverifiableReasons[0]).to.include(
          "Transfer history does not reconcile",
        )
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(false)
      })

      it("keeps independent position checks blocking with only self-transfers", async () => {
        const report = await screenExternalStbtcHoldings(
          [wallet],
          walletReader({
            getUniswapV3Positions: async () => {
              throw new Error("position state unavailable")
            },
          }),
        )
        expect(report.depositors[0].destinations).to.deep.equal([])
        expect(report.unverifiableReasons).to.have.length(1)
        expect(report.unverifiableReasons[0]).to.include(
          "position state unavailable",
        )
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(false)
      })
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
              pool: "0x0000000000000000000000000000000000000005",
              token0: "0x0000000000000000000000000000000000000003",
              token1: "0x0000000000000000000000000000000000000004",
              fee: 3000,
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
      expect(report.detectedClaimReasons[0]).to.include(
        "in pool 0x0000000000000000000000000000000000000005",
      )
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

    describe("direct Uniswap V3 core positions", () => {
      const stbtc = getAddress("0x00000000000000000000000000000000000000aa")
      const tbtc = getAddress("0x00000000000000000000000000000000000000bb")
      const wbtc = getAddress("0x00000000000000000000000000000000000000cc")
      const anchoredPool = anchors.UNISWAP_V3_TBTC_STBTC_POOL
      const otherStbtcPool = getAddress(
        "0x0000000000000000000000000000000000000b0b",
      )
      const unrelatedPool = getAddress(
        "0x0000000000000000000000000000000000000c0c",
      )
      const mintTopic = id(
        "Mint(address,address,int24,int24,uint128,uint256,uint256)",
      )
      const tick = (value: number) =>
        toBeHex(BigInt.asUintN(256, BigInt(value)), 32)
      const mintLog = (
        pool: string,
        tickLower: number,
        tickUpper: number,
        index: number,
        owner = depositor,
      ): Log =>
        ({
          address: pool,
          topics: [
            mintTopic,
            zeroPadValue(owner, 32),
            tick(tickLower),
            tick(tickUpper),
          ],
          transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
          index,
        }) as unknown as Log
      const identities: Record<string, UniswapV3PoolIdentity> = {
        [anchoredPool]: {
          factory: anchors.UNISWAP_V3_FACTORY,
          token0: tbtc,
          token1: stbtc,
          fee: 10000,
        },
        [otherStbtcPool]: {
          factory: anchors.UNISWAP_V3_FACTORY,
          token0: stbtc,
          token1: wbtc,
          fee: 3000,
        },
        [unrelatedPool]: {
          factory: anchors.UNISWAP_V3_FACTORY,
          token0: tbtc,
          token1: wbtc,
          fee: 500,
        },
      }
      const factoryInterface = new Interface([
        "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
      ])
      const poolCreationLog = (pool: string): Log => {
        const identity = identities[pool]
        const event = factoryInterface.getEvent("PoolCreated")
        if (!event) {
          throw new Error("missing PoolCreated event")
        }
        return {
          address: anchors.UNISWAP_V3_FACTORY,
          ...factoryInterface.encodeEventLog(event, [
            identity.token0,
            identity.token1,
            identity.fee,
            10,
            pool,
          ]),
        } as unknown as Log
      }
      const coreReader = (
        logs: Log[],
        overrides: Partial<UniswapV3CoreReader> = {},
      ): UniswapV3CoreReader => ({
        getDirectMintLogs: async () => logs,
        getStbtcPoolCreationLogs: async () =>
          Object.keys(identities).map(poolCreationLog),
        getPoolIdentity: async (pool) => {
          const identity = identities[pool]
          if (!identity) {
            throw new Error(`no token0() at ${pool}`)
          }
          return identity
        },
        getRegisteredPool: async (token0, token1, fee) =>
          Object.entries(identities).find(
            ([, identity]) =>
              identity.token0 === token0 &&
              identity.token1 === token1 &&
              identity.fee === fee,
          )?.[0] ?? "0x0000000000000000000000000000000000000000",
        getCorePosition: async () => ({
          liquidity: 7n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
        }),
        ...overrides,
      })

      it("finds a range in a non-anchored canonical stBTC pool", async () => {
        const positions = await enumerateDirectCorePositions(
          depositor,
          stbtc,
          coreReader([
            mintLog(anchoredPool, -100, 100, 1),
            mintLog(otherStbtcPool, -200, 200, 2),
            // A repeated mint into the same range is one position key.
            mintLog(otherStbtcPool, -200, 200, 3),
          ]),
        )

        expect(
          positions.map((position) => [
            position.pool,
            position.tickLower,
            position.tickUpper,
            position.fee,
            position.liquidity,
          ]),
        ).to.deep.equal([
          [otherStbtcPool, -200, 200, 3000, 7n],
          [anchoredPool, -100, 100, 10000, 7n],
        ])
        expect(positions[0].token0).to.equal(stbtc)
        expect(positions[0].owner).to.equal(getAddress(depositor))

        const report = await screenExternalStbtcHoldings(
          [depositor],
          reader({ getUniswapV3Positions: async () => positions }),
        )
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(false)
        expect(report.detectedClaimReasons[0]).to.include(
          `core range -200/200 in pool ${otherStbtcPool}`,
        )
      })

      it("ignores direct ranges in pools without stBTC", async () => {
        const positions = await enumerateDirectCorePositions(
          depositor,
          stbtc,
          coreReader([mintLog(unrelatedPool, -10, 10, 4)]),
        )
        expect(positions).to.deep.equal([])
      })

      it("fails closed when authenticated pool registration or identity disagrees", async () => {
        await expect(
          enumerateDirectCorePositions(
            depositor,
            stbtc,
            coreReader([mintLog(otherStbtcPool, -1, 1, 5)], {
              getRegisteredPool: async () => anchoredPool,
            }),
          ),
        ).to.be.rejectedWith(
          `stBTC pool ${otherStbtcPool} holding a direct position for ${getAddress(
            depositor,
          )} is not the canonical factory's`,
        )
        await expect(
          enumerateDirectCorePositions(
            depositor,
            stbtc,
            coreReader([mintLog(otherStbtcPool, -1, 1, 6)], {
              getPoolIdentity: async () => ({
                ...identities[otherStbtcPool],
                factory: "0x000000000000000000000000000000000000dEaD",
              }),
            }),
          ),
        ).to.be.rejectedWith("reports non-canonical factory")
        await expect(
          enumerateDirectCorePositions(
            depositor,
            stbtc,
            coreReader([mintLog(otherStbtcPool, -1, 1, 6)], {
              getPoolIdentity: async () => identities[unrelatedPool],
            }),
          ),
        ).to.be.rejectedWith("identity disagrees with PoolCreated")
      })

      it("ignores unauthenticated emitters before parsing logs or reading identity", async () => {
        const emitter = getAddress("0x0000000000000000000000000000000000000e0e")
        let identityReads = 0
        const positions = await enumerateDirectCorePositions(
          depositor,
          stbtc,
          coreReader(
            [
              mintLog(emitter, -1, 1, 7),
              {
                ...mintLog(emitter, -1, 1, 8),
                topics: [mintTopic],
              } as unknown as Log,
              mintLog(unrelatedPool, -1, 1, 9),
            ],
            {
              getPoolIdentity: async () => {
                identityReads += 1
                throw new Error("token0 unavailable")
              },
            },
          ),
        )
        expect(identityReads).to.equal(0)
        expect(positions).to.deep.equal([])
        const report = await screenExternalStbtcHoldings(
          [depositor],
          reader({ getUniswapV3Positions: async () => positions }),
        )
        expect(
          evaluateExternalStbtcGate(report, EXTERNAL_STBTC_REVIEW_CONFIRMATION)
            .passed,
        ).to.equal(true)
      })

      it("keeps authenticated catalog, identity and position failures blocking", async () => {
        const unavailable = async (): Promise<never> => {
          throw new Error("canonical read unavailable")
        }
        const overrides: Partial<UniswapV3CoreReader>[] = [
          { getStbtcPoolCreationLogs: unavailable },
          { getPoolIdentity: unavailable },
          { getRegisteredPool: unavailable },
          { getCorePosition: unavailable },
        ]
        await Promise.all(
          overrides.map(async (override) => {
            const report = await screenExternalStbtcHoldings(
              [depositor],
              reader({
                getUniswapV3Positions: () =>
                  enumerateDirectCorePositions(
                    depositor,
                    stbtc,
                    coreReader([mintLog(otherStbtcPool, -1, 1, 7)], override),
                  ),
              }),
            )
            expect(report.unverifiableReasons[0]).to.include(
              "canonical read unavailable",
            )
            expect(
              evaluateExternalStbtcGate(
                report,
                EXTERNAL_STBTC_REVIEW_CONFIRMATION,
              ).passed,
            ).to.equal(false)
          }),
        )
      })

      it("rejects pool creation evidence from an unrelated factory", async () => {
        await expect(
          enumerateDirectCorePositions(
            depositor,
            stbtc,
            coreReader([mintLog(otherStbtcPool, -1, 1, 7)], {
              getStbtcPoolCreationLogs: async () => [
                {
                  ...poolCreationLog(otherStbtcPool),
                  address: unrelatedPool,
                } as Log,
              ],
            }),
          ),
        ).to.be.rejectedWith("non-canonical factory")
      })

      it("rejects Mint logs that are not credited to the depositor", async () => {
        await expect(
          enumerateDirectCorePositions(
            depositor,
            stbtc,
            coreReader([mintLog(otherStbtcPool, -1, 1, 8, venue)]),
          ),
        ).to.be.rejectedWith("is not credited to")
      })
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

    it("extends cached external history across only the missing block tail", async () => {
      const ranges: number[][] = []
      const provider = {
        getLogs: async (filter: Filter) => {
          const fromBlock = Number(filter.fromBlock)
          const toBlock = Number(filter.toBlock)
          ranges.push([fromBlock, toBlock])
          return [
            {
              blockNumber: toBlock,
              transactionHash: `0x${toBlock.toString(16).padStart(64, "0")}`,
              index: 0,
              removed: false,
            } as Log,
          ]
        },
      } as unknown as Pick<Provider, "getLogs">
      const manifest = loadRecoveryManifest()
      const history = createExternalStbtcLogHistory(
        manifest.addresses.tbtc,
        manifest.addresses.stbtc,
        10,
      )
      const filter = { address: manifest.addresses.stbtc }

      const baseline = await extendExternalStbtcLogHistory(
        provider,
        history,
        "sent:depositor",
        filter,
        12,
      )
      const unchanged = await extendExternalStbtcLogHistory(
        provider,
        history,
        "sent:depositor",
        filter,
        12,
      )
      const refreshed = await extendExternalStbtcLogHistory(
        provider,
        history,
        "sent:depositor",
        filter,
        15,
      )

      expect(ranges).to.deep.equal([
        [10, 12],
        [13, 15],
      ])
      expect(baseline.map((log) => log.blockNumber)).to.deep.equal([12])
      expect(unchanged.map((log) => log.blockNumber)).to.deep.equal([12])
      expect(refreshed.map((log) => log.blockNumber)).to.deep.equal([12, 15])
      await expect(
        extendExternalStbtcLogHistory(
          provider,
          history,
          "sent:depositor",
          filter,
          14,
        ),
      ).to.be.rejectedWith("cannot move sent:depositor backward")
      await expect(
        extendExternalStbtcLogHistory(
          provider,
          history,
          "sent:depositor",
          { address: manifest.addresses.tbtc },
          16,
        ),
      ).to.be.rejectedWith("changed filters")
    })

    it("retains pre-deployment factory history and binds its starting block", async () => {
      const ranges: number[][] = []
      const provider = {
        getLogs: async (filter: Filter) => {
          ranges.push([Number(filter.fromBlock), Number(filter.toBlock)])
          return Number(filter.fromBlock) === 0
            ? [
                {
                  blockNumber: 5,
                  transactionHash: `0x${"12".repeat(32)}`,
                  index: 0,
                } as Log,
              ]
            : []
        },
      }
      const history = createExternalStbtcLogHistory(depositor, venue, 10)
      const filter = { address: anchors.UNISWAP_V3_FACTORY }
      await extendExternalStbtcLogHistory(
        provider,
        history,
        "factory",
        filter,
        12,
        0,
      )
      const refreshed = await extendExternalStbtcLogHistory(
        provider,
        history,
        "factory",
        filter,
        15,
        0,
      )
      expect(ranges).to.deep.equal([
        [0, 12],
        [13, 15],
      ])
      expect(refreshed.map((log) => log.blockNumber)).to.deep.equal([5])
      await expect(
        extendExternalStbtcLogHistory(provider, history, "factory", filter, 15),
      ).to.be.rejectedWith("changed start block")
    })

    describe("complete Uniswap position history", () => {
      ;[false, true].forEach((cached) => {
        it(`detects retained pre-deployment NFT and core claims with ${cached ? "cached" : "uncached"} reads`, async () => {
          await withExternalStbtcHistory(async (fixture) => {
            const report = await screenExternalStbtcHoldings(
              [fixture.owner],
              fixture.readAt(fixture.firstBlock, cached),
            )
            expect(report.unverifiableReasons).to.deep.equal([])
            expect(
              report.depositors[0].positions.map(
                (position) => position.adapter,
              ),
            ).to.deep.equal(["uniswap-v3-nft", "uniswap-v3-core"])
            expect(report.detectedClaimReasons).to.have.length(2)
            expect(
              evaluateExternalStbtcGate(
                report,
                EXTERNAL_STBTC_REVIEW_CONFIRMATION,
              ).passed,
            ).to.equal(false)
            // Earlier transfers, burns, and a self-transfer must reconstruct
            // current ownership correctly, not revive departed NFTs.
            expect(fixture.ownerReads).to.deep.equal([11n])
            expect(
              fixture.callBlocks.every(
                (tag) => tag === fixture.blockHash(fixture.firstBlock),
              ),
            ).to.equal(true)
            const tokenQueries = fixture.queries.filter(
              (query) => query.address === fixture.stbtc,
            )
            expect(tokenQueries.length).to.be.greaterThan(0)
            expect(
              Math.min(...tokenQueries.map((query) => Number(query.fromBlock))),
            ).to.equal(anchors.STBTC_DEPLOYMENT_BLOCK)
          })
        })
      })

      it("retains old Mint evidence while applying new NFT ownership and pinned position state", async () => {
        await withExternalStbtcHistory(async (fixture) => {
          await screenExternalStbtcHoldings(
            [fixture.owner],
            fixture.readAt(fixture.firstBlock, true),
          )
          const queryCount = fixture.queries.length
          const callCount = fixture.callBlocks.length
          const report = await screenExternalStbtcHoldings(
            [fixture.owner],
            fixture.readAt(fixture.nextBlock, true),
          )
          expect(report.unverifiableReasons).to.deep.equal([])
          expect(report.depositors[0].positions).to.have.length(1)
          expect(report.depositors[0].positions[0]).to.include({
            adapter: "uniswap-v3-core",
            liquidity: 0n,
            tokensOwed0: 2n,
          })
          expect(
            evaluateExternalStbtcGate(
              report,
              EXTERNAL_STBTC_REVIEW_CONFIRMATION,
            ).passed,
          ).to.equal(false)
          expect(fixture.ownerReads).to.deep.equal([11n])
          const tailQueries = fixture.queries.slice(queryCount)
          expect(tailQueries.length).to.be.greaterThan(0)
          expect(
            tailQueries.every(
              (query) =>
                Number(query.fromBlock) === fixture.firstBlock + 1 &&
                Number(query.toBlock) === fixture.nextBlock,
            ),
          ).to.equal(true)
          expect(
            fixture.callBlocks
              .slice(callCount)
              .every((tag) => tag === fixture.blockHash(fixture.nextBlock)),
          ).to.equal(true)
        })
      })

      it("does not block fully collected pre-deployment positions", async () => {
        await withExternalStbtcHistory(
          async (fixture) => {
            const report = await screenExternalStbtcHoldings(
              [fixture.owner],
              fixture.readAt(fixture.firstBlock, false),
            )
            expect(report.depositors[0].positions).to.have.length(2)
            expect(
              evaluateExternalStbtcGate(
                report,
                EXTERNAL_STBTC_REVIEW_CONFIRMATION,
              ).passed,
            ).to.equal(true)
          },
          { closedPositions: true },
        )
      })

      ;(["nft", "core"] as const).forEach((unreadableHistory) => {
        it(`blocks when pre-deployment ${unreadableHistory} history cannot be read`, async () => {
          await withExternalStbtcHistory(
            async (fixture) => {
              const report = await screenExternalStbtcHoldings(
                [fixture.owner],
                fixture.readAt(fixture.firstBlock, true),
              )
              expect(report.unverifiableReasons[0]).to.include(
                "pre-deployment position history unavailable",
              )
              expect(
                evaluateExternalStbtcGate(
                  report,
                  EXTERNAL_STBTC_REVIEW_CONFIRMATION,
                ).passed,
              ).to.equal(false)
            },
            { unreadableHistory },
          )
        })
      })

      it("retains protocol code authentication with fixture trust roots", async () => {
        const originalHash = anchors.UNISWAP_V3_FACTORY_RUNTIME_HASH
        await withExternalStbtcHistory(
          async (fixture) => {
            const report = await screenExternalStbtcHoldings(
              [fixture.owner],
              fixture.readAt(fixture.firstBlock, false),
            )
            expect(report.unverifiableReasons[0]).to.include(
              "Uniswap V3 factory runtime hash",
            )
            expect(
              evaluateExternalStbtcGate(
                report,
                EXTERNAL_STBTC_REVIEW_CONFIRMATION,
              ).passed,
            ).to.equal(false)
          },
          { codeDrift: true },
        )
        expect(anchors.UNISWAP_V3_FACTORY_RUNTIME_HASH).to.equal(originalHash)
      })
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

  it("refreshes a long scan at newer heads and returns only the converged pass", async () => {
    const block = (number: number) => ({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}`,
    })
    const canonical = new Map([
      [10, block(10)],
      [12, block(12)],
    ])
    // Two blocks arrive during the first pass: beyond the one-block
    // convergence tolerance, so the scan must be refreshed at the new head.
    const latest = [block(10), block(12), block(12)]
    let latestRead = 0
    const provider = {
      getBlock: async (blockTag: number | "latest") => {
        if (blockTag === "latest") {
          const resolved = latest[latestRead] ?? latest[latest.length - 1]
          latestRead += 1
          return resolved
        }
        return canonical.get(blockTag) ?? null
      },
    }
    const evaluated: number[] = []

    const converged = await evaluateAtConvergedLatest(
      provider,
      async (candidate) => {
        evaluated.push(candidate.number)
        return {
          walletBalanceWei: BigInt(candidate.number),
          externalTransferCount: candidate.number - 9,
        }
      },
      3,
    )

    expect(evaluated).to.deep.equal([10, 12])
    expect(converged.initialBlock.number).to.equal(10)
    expect(converged.block.number).to.equal(12)
    expect(converged.passes).to.equal(2)
    expect(converged.headLagBlocks).to.equal(0)
    expect(converged.result).to.deep.equal({
      walletBalanceWei: 12n,
      externalTransferCount: 3,
    })
  })

  it("accepts a converged pass at most one block behind the head", async () => {
    const block = (number: number) => ({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}`,
    })
    const latest = [block(10), block(11)]
    let latestRead = 0
    const provider = {
      getBlock: async (blockTag: number | "latest") => {
        if (blockTag === "latest") {
          const resolved = latest[latestRead] ?? latest[latest.length - 1]
          latestRead += 1
          return resolved
        }
        return block(blockTag)
      },
    }
    const evaluated: number[] = []

    const converged = await evaluateAtConvergedLatest(
      provider,
      async (candidate) => {
        evaluated.push(candidate.number)
        return candidate.number
      },
      3,
    )
    expect(evaluated).to.deep.equal([10])
    expect(converged.block.number).to.equal(10)
    expect(converged.passes).to.equal(1)
    expect(converged.headLagBlocks).to.equal(1)

    // Exact convergence remains available to callers that ask for it.
    latestRead = 0
    evaluated.length = 0
    const exact = await evaluateAtConvergedLatest(
      provider,
      async (candidate) => {
        evaluated.push(candidate.number)
        return candidate.number
      },
      3,
      0,
    )
    expect(evaluated).to.deep.equal([10, 11])
    expect(exact.block.number).to.equal(11)
    expect(exact.headLagBlocks).to.equal(0)
  })

  it("fails closed when latest-state evaluation cannot converge", async () => {
    const block = (number: number) => ({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}`,
    })
    // Each pass falls two blocks behind: never within the convergence
    // tolerance, so the bounded loop must give up.
    const latest = [block(20), block(22), block(24), block(26)]
    let latestRead = 0
    const provider = {
      getBlock: async (blockTag: number | "latest") => {
        if (blockTag === "latest") {
          const resolved = latest[latestRead] ?? latest[latest.length - 1]
          latestRead += 1
          return resolved
        }
        return block(blockTag)
      },
    }
    const evaluated: number[] = []

    await expect(
      evaluateAtConvergedLatest(
        provider,
        async (candidate) => {
          evaluated.push(candidate.number)
          return candidate.number
        },
        3,
      ),
    ).to.be.rejectedWith("advanced during all 3 state evaluation passes")
    expect(evaluated).to.deep.equal([20, 22, 24])
  })

  it("rejects a reorged history boundary before scanning another tail", async () => {
    const original = {
      number: 30,
      hash: `0x${"30".repeat(32)}`,
    }
    const replacement = {
      number: 30,
      hash: `0x${"31".repeat(32)}`,
    }
    const next = {
      number: 32,
      hash: `0x${"32".repeat(32)}`,
    }
    let heightThirtyReads = 0
    let latestReads = 0
    const provider = {
      getBlock: async (blockTag: number | "latest") => {
        if (blockTag === "latest") {
          latestReads += 1
          return latestReads === 1 ? original : next
        }
        if (blockTag === 30) {
          heightThirtyReads += 1
          return heightThirtyReads === 1 ? original : replacement
        }
        return next
      },
    }
    const evaluated: number[] = []

    await expect(
      evaluateAtConvergedLatest(provider, async (candidate) => {
        evaluated.push(candidate.number)
        return candidate.number
      }),
    ).to.be.rejectedWith("pinned block 30 was reorged during the scan")
    expect(evaluated).to.deep.equal([30])
  })

  it("bounds execute-stage head lag instead of requiring the exact latest block", async () => {
    const initialHash = `0x${"11".repeat(32)}`
    const replacementHash = `0x${"22".repeat(32)}`
    const headHash = `0x${"33".repeat(32)}`
    const provider = (
      latestNumber: number,
      canonicalAtHeight = initialHash,
    ) => ({
      getBlock: async (blockTag: number | "latest") => {
        if (blockTag === "latest") {
          return {
            number: latestNumber,
            hash: latestNumber === 100 ? canonicalAtHeight : headHash,
          }
        }
        return { number: blockTag, hash: canonicalAtHeight }
      },
    })

    expect(
      await assertStillLatestBlock(provider(100), 100, initialHash),
    ).to.deep.equal({ latestBlockNumber: 100, headLagBlocks: 0 })
    expect(
      await assertStillLatestBlock(provider(103), 100, initialHash),
    ).to.deep.equal({ latestBlockNumber: 103, headLagBlocks: 3 })
    await expect(
      assertStillLatestBlock(provider(104), 100, initialHash),
    ).to.be.rejectedWith(
      "state became stale before preflight completion: validated block 100",
    )
    await expect(
      assertStillLatestBlock(provider(104), 100, initialHash),
    ).to.be.rejectedWith("4 blocks ahead of the 3-block freshness budget")
    await expect(
      assertStillLatestBlock(provider(101), 100, initialHash, 0),
    ).to.be.rejectedWith("1 blocks ahead of the 0-block freshness budget")
    await expect(
      assertStillLatestBlock(provider(100, replacementHash), 100, initialHash),
    ).to.be.rejectedWith("replaced at the same height")
    await expect(
      assertStillLatestBlock(provider(101, replacementHash), 100, initialHash),
    ).to.be.rejectedWith("pinned block 100 was reorged during the scan")
    await expect(
      assertStillLatestBlock(provider(99), 100, initialHash),
    ).to.be.rejectedWith("head regressed to 99")
    await expect(
      assertStillLatestBlock(provider(100), 100, null),
    ).to.be.rejectedWith("validated block 100 has no hash")
  })

  it("rechecks every number-pinned workflow before accepting its output", () => {
    const preflightSource = readFileSync(
      join(__dirname, "..", "scripts", "prepare-stbtc-recovery.ts"),
      "utf8",
    )
    const recheck = preflightSource.lastIndexOf(
      "await assertPinnedBlockHashUnchanged",
    )
    const convergedExternalScan = preflightSource.indexOf(
      "await evaluateAtConvergedLatest",
    )
    const firstMutableCoreRead = preflightSource.indexOf(
      "const implementation =",
    )
    const latestHeadRecheck = preflightSource.lastIndexOf(
      "await assertStillLatestBlock",
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
    expect(convergedExternalScan).to.be.greaterThan(-1)
    expect(firstMutableCoreRead).to.be.greaterThan(convergedExternalScan)
    expect(
      preflightSource.lastIndexOf("screenExternalStbtcHoldings("),
    ).to.be.lessThan(firstMutableCoreRead)
    expect(finalStatus).to.be.greaterThan(recheck)
    expect(latestHeadRecheck).to.be.greaterThan(recheck)
    expect(finalStatus).to.be.greaterThan(latestHeadRecheck)
    expect(emission).to.be.greaterThan(finalStatus)
    expect(preflightSource.slice(recheck, finalStatus)).to.include(
      "appendDeferredFailure",
    )
    const firstPersistedSnapshotCheck = preflightSource.indexOf(
      "await assertManifestSnapshotCanonical",
    )
    const finalPersistedSnapshotCheck = preflightSource.lastIndexOf(
      "await assertManifestSnapshotCanonical",
    )
    expect(firstPersistedSnapshotCheck).to.be.greaterThan(-1)
    expect(finalPersistedSnapshotCheck).to.be.greaterThan(
      firstPersistedSnapshotCheck,
    )
    expect(preflightSource.indexOf("const atSnapshotBlock")).to.be.greaterThan(
      firstPersistedSnapshotCheck,
    )
    expect(finalPersistedSnapshotCheck).to.be.greaterThan(
      preflightSource.indexOf("output.governanceBatch ="),
    )
    expect(finalStatus).to.be.greaterThan(finalPersistedSnapshotCheck)

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
      if (script === "check-external-stbtc.ts") {
        const firstPersistedCheck = source.indexOf(
          "await assertManifestSnapshotCanonical",
        )
        const finalPersistedCheck = source.lastIndexOf(
          "await assertManifestSnapshotCanonical",
        )
        const report = source.indexOf(
          "const report = await screenExternalStbtcHoldings",
          firstPersistedCheck,
        )
        expect(firstPersistedCheck).to.be.greaterThan(-1)
        expect(report).to.be.greaterThan(firstPersistedCheck)
        expect(finalPersistedCheck).to.be.greaterThan(report)
        expect(source.indexOf(acceptanceMarker)).to.be.greaterThan(
          finalPersistedCheck,
        )
      }
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
