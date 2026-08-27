import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import {
  createSnapshot,
  restoreSnapshot,
} from "@keep-network/hardhat-helpers/dist/snapshot"
import { to1ePrecision } from "@keep-network/hardhat-helpers/dist/number"
import { MockERC20, MockSTBTC, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TbtcMigrationState } from "../types"

describe("Portal - to-tBTC migrations", () => {
  let TBTC: MockERC20
  let WBTC: MockERC20
  let stBTC: MockSTBTC
  let tbtcAddress: string
  let wbtcAddress: string
  let stbtcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner
  let depositorThree: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let tbtcMigrationTreasuryMultisig: HardhatEthersSigner

  const depositOneAmount = to1ePrecision(1, 8) // 1 WBTC
  const depositTwoAmount = to1ePrecision(3, 8) // 3 WBTC
  const depositThreeAmount = to1ePrecision(2, 8) // 2 WBTC
  const depositOneId = 1
  const depositTwoId = 2
  const depositThreeId = 3
  const noLockPeriod = 0
  const wbtcToTbtcDecimalsRatio = BigInt(10 ** 10) // from 8 decimals to 18 decimals

  before(async () => {
    ;({
      TBTC,
      WBTC,
      stBTC,
      tbtcAddress,
      wbtcAddress,
      stbtcAddress,
      portal,
      deployer,
      depositorOne,
      depositorTwo,
      depositorThree,
      thirdParty,
      tbtcMigrationTreasuryMultisig,
    } = await loadFixture(deployPortal))

    await portal.setTbtcTokenAddress(tbtcAddress)

    await WBTC.connect(depositorOne).approve(
      await portal.getAddress(),
      depositOneAmount,
    )
    await portal
      .connect(depositorOne)
      .deposit(wbtcAddress, depositOneAmount, noLockPeriod)

    await WBTC.connect(depositorTwo).approve(
      await portal.getAddress(),
      depositTwoAmount,
    )
    await portal
      .connect(depositorTwo)
      .deposit(wbtcAddress, depositTwoAmount, noLockPeriod)

    await WBTC.connect(depositorThree).approve(
      await portal.getAddress(),
      depositTwoAmount,
    )
    await portal
      .connect(depositorThree)
      .deposit(wbtcAddress, depositThreeAmount, noLockPeriod)
  })

  describe("requestTbtcMigration", () => {
    context("when called incorrectly", () => {
      context("when migration was not allowed by governance", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .requestTbtcMigration(wbtcAddress, depositOneId),
          ).to.be.revertedWithCustomError(portal, "TbtcMigrationNotAllowed")
        })
      })

      context("when already requested", () => {
        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)
          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .requestTbtcMigration(wbtcAddress, depositOneId),
          )
            .to.be.revertedWithCustomError(
              portal,
              "UnexpectedTbtcMigrationState",
            )
            .withArgs(
              depositOneId,
              TbtcMigrationState.Requested,
              TbtcMigrationState.NotRequested,
            )
        })
      })
    })
  })

  context("when called correctly", () => {
    let tx: ContractTransactionResponse

    before(async () => {
      await createSnapshot()

      await portal
        .connect(deployer)
        .setAssetTbtcMigrationAllowed(wbtcAddress, true)
      tx = await portal
        .connect(depositorOne)
        .requestTbtcMigration(wbtcAddress, depositOneId)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should mark the deposit as migration-requested", async () => {
      const deposit = await portal.getDeposit(
        depositorOne.address,
        wbtcAddress,
        depositOneId,
      )

      expect(deposit.tbtcMigrationState).to.equal(TbtcMigrationState.Requested)
    })

    it("should emit TbtcMigrationRequested event", async () => {
      await expect(tx)
        .to.emit(portal, "TbtcMigrationRequested")
        .withArgs(depositorOne.address, wbtcAddress, depositOneId)
    })
  })

  describe("withdrawForTbtcMigration", () => {
    context("when called incorrectly", () => {
      context("when called by a third party", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(thirdParty)
              .withdrawForTbtcMigration(wbtcAddress, []),
          ).to.be.revertedWithCustomError(
            portal,
            "SenderNotTbtcMigrationTreasury",
          )
        })
      })

      context(
        "when called for a deposit which which migration was not requested",
        () => {
          before(async () => {
            await createSnapshot()

            await portal
              .connect(deployer)
              .setAssetTbtcMigrationAllowed(wbtcAddress, true)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              portal
                .connect(tbtcMigrationTreasuryMultisig)
                .withdrawForTbtcMigration(wbtcAddress, [
                  {
                    depositor: depositorOne.address,
                    depositId: depositOneId,
                  },
                ]),
            )
              .to.be.revertedWithCustomError(
                portal,
                "UnexpectedTbtcMigrationState",
              )
              .withArgs(
                depositOneId,
                TbtcMigrationState.NotRequested,
                TbtcMigrationState.Requested,
              )
          })
        },
      )

      context("when already called for the deposit", () => {
        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)
          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)

          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .withdrawForTbtcMigration(wbtcAddress, [
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
            ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(tbtcMigrationTreasuryMultisig)
                .withdrawForTbtcMigration(wbtcAddress, [
                  {
                    depositor: depositorTwo.address,
                    depositId: depositTwoId,
                  },
                  {
                    depositor: depositorOne.address,
                    depositId: depositOneId,
                  },
                ]),
            ).to.be.revertedWithCustomError(portal, "TbtcMigrationNotRequested")
          })
        })
      })

      context("when called for non-existing deposit", () => {
        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal
              .connect(tbtcMigrationTreasuryMultisig)
              .withdrawForTbtcMigration(wbtcAddress, [
                {
                  depositor: depositorTwo.address,
                  depositId: depositOneId,
                },
              ]),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })
    })

    context("when called correctly", () => {
      let expectedTotalMigrating: bigint
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await portal
          .connect(deployer)
          .setAssetTbtcMigrationAllowed(wbtcAddress, true)

        await portal
          .connect(depositorOne)
          .requestTbtcMigration(wbtcAddress, depositOneId)
        await portal
          .connect(depositorTwo)
          .requestTbtcMigration(wbtcAddress, depositTwoId)
        await portal
          .connect(depositorThree)
          .requestTbtcMigration(wbtcAddress, depositThreeId)

        // 3 deposits requested migration but we only take 2 for now
        expectedTotalMigrating = depositOneAmount + depositTwoAmount
        tx = await portal
          .connect(tbtcMigrationTreasuryMultisig)
          .withdrawForTbtcMigration(wbtcAddress, [
            {
              depositor: depositorTwo.address,
              depositId: depositTwoId,
            },
            {
              depositor: depositorOne.address,
              depositId: depositOneId,
            },
          ])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mark the deposit as migration-in-progress", async () => {
        const depositOne = await portal.getDeposit(
          depositorOne.address,
          wbtcAddress,
          depositOneId,
        )

        const depositTwo = await portal.getDeposit(
          depositorTwo.address,
          wbtcAddress,
          depositTwoId,
        )

        expect(depositOne.tbtcMigrationState).to.equal(
          TbtcMigrationState.InProgress,
        )
        expect(depositTwo.tbtcMigrationState).to.equal(
          TbtcMigrationState.InProgress,
        )
      })

      it("should update the total migrating amount", async () => {
        const migration = await portal.tbtcMigrations(wbtcAddress)
        expect(migration.totalMigrating).to.equal(expectedTotalMigrating)
      })

      it("should withdraw migrated token to the treasury", async () => {
        await expect(tx).to.changeTokenBalances(
          WBTC,
          [await portal.getAddress(), tbtcMigrationTreasuryMultisig.address],
          [-expectedTotalMigrating, expectedTotalMigrating],
        )
      })

      it("should emit TbtcMigrationStarted event", async () => {
        await expect(tx)
          .to.emit(portal, "TbtcMigrationStarted")
          .withArgs(depositorOne.address, wbtcAddress, depositOneId)
        await expect(tx)
          .to.emit(portal, "TbtcMigrationStarted")
          .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)
      })

      it("should emit WithdrawnForTbtcMigration event", async () => {
        await expect(tx)
          .to.emit(portal, "WithdrawnForTbtcMigration")
          .withArgs(wbtcAddress, expectedTotalMigrating)
      })
    })
  })

  describe("completeTbtcMigration", () => {
    context("when called incorrectly", () => {
      context("when called by a third party", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(thirdParty).completeTbtcMigration(wbtcAddress, []),
          ).to.be.revertedWithCustomError(
            portal,
            "SenderNotTbtcMigrationTreasury",
          )
        })
      })

      context("when called for a deposit with no migration in progress", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(tbtcMigrationTreasuryMultisig)
              .completeTbtcMigration(wbtcAddress, [
                {
                  depositor: depositorOne.address,
                  depositId: depositOneId,
                },
              ]),
          )
            .to.be.revertedWithCustomError(
              portal,
              "UnexpectedTbtcMigrationState",
            )
            .withArgs(
              depositOneId,
              TbtcMigrationState.NotRequested,
              TbtcMigrationState.InProgress,
            )
        })
      })

      context("when called again for the same deposit", () => {
        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)

          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)

          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .withdrawForTbtcMigration(wbtcAddress, [
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
            ])

          await TBTC.connect(tbtcMigrationTreasuryMultisig).approve(
            await portal.getAddress(),
            depositOneAmount * wbtcToTbtcDecimalsRatio,
          )
          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .completeTbtcMigration(wbtcAddress, [
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
            ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal
              .connect(tbtcMigrationTreasuryMultisig)
              .completeTbtcMigration(wbtcAddress, [
                {
                  depositor: depositorOne.address,
                  depositId: depositOneId,
                },
              ]),
          )
            .to.be.revertedWithCustomError(
              portal,
              "UnexpectedTbtcMigrationState",
            )
            .withArgs(
              depositOneId,
              TbtcMigrationState.Completed,
              TbtcMigrationState.InProgress,
            )
        })
      })
    })

    context("when called correctly", () => {
      let totalMigratingWbtc: bigint
      let totalMigratedWbtc: bigint
      let totalNewTbtc: bigint

      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await portal
          .connect(deployer)
          .setAssetTbtcMigrationAllowed(wbtcAddress, true)

        await portal
          .connect(depositorOne)
          .requestTbtcMigration(wbtcAddress, depositOneId)
        await portal
          .connect(depositorTwo)
          .requestTbtcMigration(wbtcAddress, depositTwoId)
        await portal
          .connect(depositorThree)
          .requestTbtcMigration(wbtcAddress, depositThreeId)

        totalMigratingWbtc =
          depositOneAmount + depositTwoAmount + depositThreeAmount
        await portal
          .connect(tbtcMigrationTreasuryMultisig)
          .withdrawForTbtcMigration(wbtcAddress, [
            {
              depositor: depositorOne.address,
              depositId: depositOneId,
            },
            {
              depositor: depositorTwo.address,
              depositId: depositTwoId,
            },
            {
              depositor: depositorThree.address,
              depositId: depositThreeId,
            },
          ])

        totalMigratedWbtc = depositTwoAmount + depositThreeAmount
        totalNewTbtc = totalMigratedWbtc * wbtcToTbtcDecimalsRatio
        await TBTC.connect(tbtcMigrationTreasuryMultisig).approve(
          await portal.getAddress(),
          totalNewTbtc,
        )
        tx = await portal
          .connect(tbtcMigrationTreasuryMultisig)
          .completeTbtcMigration(wbtcAddress, [
            {
              depositor: depositorTwo.address,
              depositId: depositTwoId,
            },
            {
              depositor: depositorThree.address,
              depositId: depositThreeId,
            },
          ])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should mark the deposits as migration-completed", async () => {
        const depositTwo = await portal.getDeposit(
          depositorTwo.address,
          wbtcAddress,
          depositTwoId,
        )

        const depositThree = await portal.getDeposit(
          depositorThree.address,
          wbtcAddress,
          depositThreeId,
        )

        expect(depositTwo.tbtcMigrationState).to.equal(
          TbtcMigrationState.Completed,
        )
        expect(depositThree.tbtcMigrationState).to.equal(
          TbtcMigrationState.Completed,
        )
      })

      it("should update the total migrating amount", async () => {
        const migration = await portal.tbtcMigrations(wbtcAddress)
        expect(migration.totalMigrating).to.equal(
          totalMigratingWbtc - totalMigratedWbtc,
        )
      })

      it("should fund Portal with migrated tBTC", async () => {
        await expect(tx).to.changeTokenBalances(
          TBTC,
          [await portal.getAddress(), tbtcMigrationTreasuryMultisig.address],
          [totalNewTbtc, -totalNewTbtc],
        )
      })

      it("should emit TbtcMigrationCompleted event", async () => {
        await expect(tx)
          .to.emit(portal, "TbtcMigrationCompleted")
          .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)
        await expect(tx)
          .to.emit(portal, "TbtcMigrationCompleted")
          .withArgs(depositorThree.address, wbtcAddress, depositThreeId)
      })

      it("should emit FundedFromTbtcMigration event", async () => {
        await expect(tx)
          .to.emit(portal, "FundedFromTbtcMigration")
          .withArgs(totalNewTbtc)
      })
    })
  })

  describe("withdraw", () => {
    context(
      "when to-tBTC migration was requested for the deposit and not yet completed",
      () => {
        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)

          // Request migration for two deposits and initiate migration for
          // one of them. They both should be non-withdrawable.
          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)
          await portal
            .connect(depositorTwo)
            .requestTbtcMigration(wbtcAddress, depositTwoId)
          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .withdrawForTbtcMigration(wbtcAddress, [
              {
                depositor: depositorTwo.address,
                depositId: depositTwoId,
              },
            ])
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(wbtcAddress, depositOneId),
          ).to.be.revertedWithCustomError(portal, "TbtcMigrationNotCompleted")
          await expect(
            portal.connect(depositorTwo).withdraw(wbtcAddress, depositTwoId),
          ).to.be.revertedWithCustomError(portal, "TbtcMigrationNotCompleted")
        })
      },
    )

    context(
      "when to-tBTC migration for the deposit was completed",
      async () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)

          //
          // We will request migration of 3 deposits, initiate and complete
          // migration of 2 deposits and withdraw only 1 deposit. Just to make
          // it all more interesting.
          //

          await portal
            .connect(depositorTwo)
            .requestTbtcMigration(wbtcAddress, depositTwoId)
          await portal
            .connect(depositorThree)
            .requestTbtcMigration(wbtcAddress, depositThreeId)

          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .withdrawForTbtcMigration(wbtcAddress, [
              {
                depositor: depositorTwo.address,
                depositId: depositTwoId,
              },
              {
                depositor: depositorThree.address,
                depositId: depositThreeId,
              },
            ])

          const totalMigratedWbtc = depositTwoAmount + depositThreeAmount
          const totalNewTbtc = totalMigratedWbtc * wbtcToTbtcDecimalsRatio
          await TBTC.connect(tbtcMigrationTreasuryMultisig).approve(
            await portal.getAddress(),
            totalNewTbtc,
          )
          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .completeTbtcMigration(wbtcAddress, [
              {
                depositor: depositorTwo.address,
                depositId: depositTwoId,
              },
              {
                depositor: depositorThree.address,
                depositId: depositThreeId,
              },
            ])

          tx = await portal
            .connect(depositorTwo)
            .withdraw(wbtcAddress, depositTwoId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should withdraw funds in tBTC", async () => {
          const expectedTbtc = depositTwoAmount * wbtcToTbtcDecimalsRatio
          await expect(tx).to.changeTokenBalances(
            TBTC,
            [await portal.getAddress(), depositorTwo.address],
            [-expectedTbtc, expectedTbtc],
          )
        })

        it("should emit WithdrawnTbtcMigrated event", async () => {
          const expectedTbtc = depositTwoAmount * wbtcToTbtcDecimalsRatio

          await expect(tx)
            .to.emit(portal, "WithdrawnTbtcMigrated")
            .withArgs(
              depositorTwo.address,
              wbtcAddress,
              tbtcAddress,
              depositTwoId,
              expectedTbtc,
            )
        })

        it("should not emit Withdrawn event", async () => {
          await expect(tx).not.to.emit(portal, "Withdrawn")
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorTwo.address,
            wbtcAddress,
            depositTwoId,
          )

          expect(deposit.balance).to.equal(0)
          expect(deposit.unlockAt).to.equal(0)
          expect(deposit.receiptMinted).to.equal(0)
          expect(deposit.feeOwed).to.equal(0)
          expect(deposit.lastFeeIntegral).to.equal(0)
          expect(deposit.tbtcMigrationState).to.equal(
            TbtcMigrationState.NotRequested,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorTwo).withdraw(wbtcAddress, depositTwoId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      },
    )

    context(
      "when to-tBTC migration for receipt minted deposit was completed",
      async () => {
        const receiptMinted = depositOneAmount * wbtcToTbtcDecimalsRatio
        let feeOwed: bigint
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(wbtcAddress, 20, 100, stbtcAddress)
          await portal
            .connect(depositorOne)
            .mintReceipt(wbtcAddress, depositOneId, receiptMinted)

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)

          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)

          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .withdrawForTbtcMigration(wbtcAddress, [
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
            ])

          const totalNewTbtc = depositOneAmount * wbtcToTbtcDecimalsRatio
          await TBTC.connect(tbtcMigrationTreasuryMultisig).approve(
            await portal.getAddress(),
            totalNewTbtc,
          )
          await portal
            .connect(tbtcMigrationTreasuryMultisig)
            .completeTbtcMigration(wbtcAddress, [
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
            ])

          await helpers.time.increaseTime(60 * 86400) // 60 days

          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), receiptMinted)
          await portal
            .connect(depositorOne)
            .repayReceipt(wbtcAddress, depositOneId, receiptMinted)

          const deposit = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositOneId,
          )

          // feeOwed is in the receipt token precision so for stBTC it is 1e18
          feeOwed = deposit.feeOwed

          tx = await portal
            .connect(depositorOne)
            .withdraw(wbtcAddress, depositOneId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should withdraw funds in tBTC", async () => {
          const withdrawableTbtc =
            depositOneAmount * wbtcToTbtcDecimalsRatio - feeOwed

          await expect(tx).to.changeTokenBalances(
            TBTC,
            [await portal.getAddress(), depositorOne.address],
            [-withdrawableTbtc, withdrawableTbtc],
          )
        })

        it("should collect the fee in tBTC", async () => {
          // 60 days, 20% fee, and 1 stBTC minted:
          // (1 * 0.2) * (60 / 365) = ~0.0328767
          // Precise fee calculations are covered in the general withdraw
          // function unit tests. Here we just make a sanity check for tBTC
          // conversion.

          const info = await portal.feeInfo(tbtcAddress)
          expect(info.feeCollected).to.be.closeTo(
            32870000000000000n, // 0.3287
            100000000000000n, // 0.0001 tolerance
          )
        })

        it("should emit WithdrawnTbtcMigrated event", async () => {
          const withdrawableTbtc =
            depositOneAmount * wbtcToTbtcDecimalsRatio - feeOwed

          await expect(tx)
            .to.emit(portal, "WithdrawnTbtcMigrated")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              tbtcAddress,
              depositOneId,
              withdrawableTbtc,
            )
        })

        it("should not emit Withdrawn event", async () => {
          await expect(tx).not.to.emit(portal, "Withdrawn")
        })

        it("should emit FeeCollectedTbtcMigrated event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollectedTbtcMigrated")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              tbtcAddress,
              depositOneId,
              feeOwed,
            )
        })

        it("should not emit FeeCollected event", async () => {
          await expect(tx).not.to.emit(portal, "FeeCollected")
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositOneId,
          )

          expect(deposit.balance).to.equal(0)
          expect(deposit.unlockAt).to.equal(0)
          expect(deposit.receiptMinted).to.equal(0)
          expect(deposit.feeOwed).to.equal(0)
          expect(deposit.lastFeeIntegral).to.equal(0)
          expect(deposit.tbtcMigrationState).to.equal(
            TbtcMigrationState.NotRequested,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(wbtcAddress, depositOneId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      },
    )
  })

  describe("withdrawPartially", () => {
    context("when to-tBTC migration was requested", () => {
      before(async () => {
        await createSnapshot()

        await portal
          .connect(deployer)
          .setAssetTbtcMigrationAllowed(wbtcAddress, true)

        // Request migration for two deposits and initiate migration for
        // one of them. They both should be non-withdrawable.
        await portal
          .connect(depositorOne)
          .requestTbtcMigration(wbtcAddress, depositOneId)
        await portal
          .connect(depositorTwo)
          .requestTbtcMigration(wbtcAddress, depositTwoId)
        await portal
          .connect(tbtcMigrationTreasuryMultisig)
          .withdrawForTbtcMigration(wbtcAddress, [
            {
              depositor: depositorTwo.address,
              depositId: depositTwoId,
            },
          ])
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(wbtcAddress, depositOneId, 100),
        ).to.be.revertedWithCustomError(portal, "TbtcMigrationRequestedErr")
        await expect(
          portal
            .connect(depositorTwo)
            .withdrawPartially(wbtcAddress, depositTwoId, 100),
        ).to.be.revertedWithCustomError(portal, "TbtcMigrationRequestedErr")
      })
    })
  })
})
