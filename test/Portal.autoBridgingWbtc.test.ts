import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { to1ePrecision } from "@keep-network/hardhat-helpers/dist/number"
import {
  createSnapshot,
  restoreSnapshot,
} from "@keep-network/hardhat-helpers/dist/snapshot"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { MezoBridge, MockERC20, MockWBTC, Portal } from "../typechain"
import { TbtcMigrationState } from "../types"
import deployPortal from "./fixtures/deployPortal"

describe("Portal - auto-bridging WBTC", () => {
  let portal: Portal
  let mezoBridge: MezoBridge
  let TBTC: MockERC20
  let WBTC: MockWBTC

  let tbtcAddress: string
  let wbtcAddress: string
  let stbtcAddress: string

  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner
  let depositorThree: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let autoBridgeCoordinator: HardhatEthersSigner
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
      portal,
      mezoBridge,
      deployer,
      depositorOne,
      depositorTwo,
      depositorThree,
      thirdParty,
      autoBridgeCoordinator,
      tbtcMigrationTreasuryMultisig,
      tbtcAddress,
      wbtcAddress,
      stbtcAddress,
      TBTC,
      WBTC,
    } = await loadFixture(deployPortal))

    await portal.setTbtcTokenAddress(tbtcAddress)
    await portal.setWbtcTokenAddress(wbtcAddress)
    await portal.setMezoBridge(await mezoBridge.getAddress())
    await portal
      .connect(deployer)
      .setAssetTbtcMigrationAllowed(wbtcAddress, true)
    await portal.setReceiptParams(wbtcAddress, 5, 100, stbtcAddress)

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
      depositThreeAmount,
    )
    await portal
      .connect(depositorThree)
      .deposit(wbtcAddress, depositThreeAmount, noLockPeriod)
  })

  describe("batchRequestWbtcToTbtcMigration", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).batchRequestWbtcToTbtcMigration([
            {
              depositor: depositorOne.address,
              depositId: depositOneId,
            },
          ]),
        ).to.be.revertedWithCustomError(
          portal,
          "CallerNotAutoBridgeCoordinator",
        )
      })
    })

    context("when called by the coordinator", () => {
      context("when deposit is opt out from auto-bridging", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(depositorTwo)
            ["setDepositAutoBridgingOptOut(address,uint256,bool)"](
              wbtcAddress,
              depositTwoId,
              true,
            )

          tx = await portal
            .connect(autoBridgeCoordinator)
            .batchRequestWbtcToTbtcMigration([
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should skip the deposit ", async () => {
          await expect(tx)
            .to.emit(portal, "OptOutDepositAutoBridgingSkipped")
            .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)

          expect(
            (
              await portal.getDeposit(
                depositorTwo.address,
                wbtcAddress,
                depositTwoId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.NotRequested)
        })

        it("should request migration for other deposits", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                wbtcAddress,
                depositOneId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          expect(
            (
              await portal.getDeposit(
                depositorThree.address,
                wbtcAddress,
                depositThreeId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorOne.address, wbtcAddress, depositOneId)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorThree.address, wbtcAddress, depositThreeId)
        })
      })

      context("when deposit is already requested for migration", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(depositorOne)
            .requestTbtcMigration(wbtcAddress, depositOneId)

          tx = await portal
            .connect(autoBridgeCoordinator)
            .batchRequestWbtcToTbtcMigration([
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should skip the deposit", async () => {
          await expect(tx)
            .to.emit(portal, "TbtcMigratingDepositAutoBridgingSkipped")
            .withArgs(depositorOne.address, wbtcAddress, depositOneId)
        })

        it("should request migration for other deposits", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorTwo.address,
                wbtcAddress,
                depositTwoId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          expect(
            (
              await portal.getDeposit(
                depositorThree.address,
                wbtcAddress,
                depositThreeId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorThree.address, wbtcAddress, depositThreeId)
        })
      })

      context("when deposit has been withdrawn", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal.connect(depositorOne).withdraw(wbtcAddress, depositOneId)

          tx = await portal
            .connect(autoBridgeCoordinator)
            .batchRequestWbtcToTbtcMigration([
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should skip the deposit", async () => {
          await expect(tx)
            .to.emit(portal, "WithdrawnDepositAutoBridgingSkipped")
            .withArgs(depositorOne.address, wbtcAddress, depositOneId)

          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                wbtcAddress,
                depositOneId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.NotRequested)
        })

        it("should request migration for other deposits", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorTwo.address,
                wbtcAddress,
                depositTwoId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          expect(
            (
              await portal.getDeposit(
                depositorThree.address,
                wbtcAddress,
                depositThreeId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorThree.address, wbtcAddress, depositThreeId)
        })
      })

      context("when deposit has receipt token minted and not repaid", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(depositorThree)
            .mintReceipt(wbtcAddress, depositThreeId, depositThreeAmount / 2n)

          tx = await portal
            .connect(autoBridgeCoordinator)
            .batchRequestWbtcToTbtcMigration([
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should skip the deposit", async () => {
          await expect(tx)
            .to.emit(portal, "ReceiptMintedDepositAutoBridgingSkipped")
            .withArgs(depositorThree.address, wbtcAddress, depositThreeId)

          expect(
            (
              await portal.getDeposit(
                depositorThree.address,
                wbtcAddress,
                depositThreeId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.NotRequested)
        })

        it("should request migration for other deposits", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                wbtcAddress,
                depositOneId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          expect(
            (
              await portal.getDeposit(
                depositorTwo.address,
                wbtcAddress,
                depositTwoId,
              )
            ).tbtcMigrationState,
          ).to.equal(TbtcMigrationState.Requested)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorOne.address, wbtcAddress, depositOneId)

          await expect(tx)
            .to.emit(portal, "TbtcMigrationRequested")
            .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)
        })
      })
    })
  })

  describe("autoBridgeWbtcDeposits", () => {
    before(async () => {
      await createSnapshot()

      await portal
        .connect(autoBridgeCoordinator)
        .batchRequestWbtcToTbtcMigration([
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
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).autoBridgeWbtcDeposits([
            {
              depositor: depositorOne.address,
              depositId: depositOneId,
            },
          ]),
        ).to.be.revertedWithCustomError(
          portal,
          "CallerNotAutoBridgeCoordinator",
        )
      })
    })

    context("when called by the coordinator", () => {
      context("when migration was not completed", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(autoBridgeCoordinator).autoBridgeWbtcDeposits([
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
            ]),
          ).to.be.revertedWithCustomError(portal, "TbtcMigrationNotCompleted")
        })
      })

      context("when migration was completed", () => {
        before(async () => {
          await createSnapshot()

          const totalMigratedWbtc =
            depositOneAmount + depositTwoAmount + depositThreeAmount

          const totalNewTbtc = totalMigratedWbtc * wbtcToTbtcDecimalsRatio

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

        context("when deposit is opt out from auto-bridging", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal
              .connect(depositorTwo)
              ["setDepositAutoBridgingOptOut(address,uint256,bool)"](
                wbtcAddress,
                depositTwoId,
                true,
              )

            tx = await portal
              .connect(autoBridgeCoordinator)
              .autoBridgeWbtcDeposits([
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
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should skip the deposit", async () => {
            await expect(tx)
              .to.emit(portal, "OptOutDepositAutoBridgingSkipped")
              .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)

            expect(await mezoBridge.sequence()).to.eq(2) // 2 deposits bridged
          })

          it("should bridge other deposits", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                1,
                depositorOne.address,
                tbtcAddress,
                depositOneAmount * wbtcToTbtcDecimalsRatio,
              )
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                2,
                depositorThree.address,
                tbtcAddress,
                depositThreeAmount * wbtcToTbtcDecimalsRatio,
              )

            const totalBridgedTbtc = depositOneAmount + depositThreeAmount
            const totalNewTbtc = totalBridgedTbtc * wbtcToTbtcDecimalsRatio

            await expect(tx).to.changeTokenBalance(
              TBTC,
              mezoBridge,
              totalNewTbtc,
            )
            await expect(tx).to.changeTokenBalance(TBTC, portal, -totalNewTbtc)
          })
        })

        context("when deposit has been withdrawn", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal
              .connect(depositorOne)
              .withdraw(wbtcAddress, depositOneId)

            tx = await portal
              .connect(autoBridgeCoordinator)
              .autoBridgeWbtcDeposits([
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
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should skip the deposit", async () => {
            await expect(tx)
              .to.emit(portal, "WithdrawnDepositAutoBridgingSkipped")
              .withArgs(depositorOne.address, wbtcAddress, depositOneId)

            expect(await mezoBridge.sequence()).to.eq(2) // 2 deposits bridged
          })

          it("should bridge other deposits", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                1,
                depositorTwo.address,
                tbtcAddress,
                depositTwoAmount * wbtcToTbtcDecimalsRatio,
              )
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                2,
                depositorThree.address,
                tbtcAddress,
                depositThreeAmount * wbtcToTbtcDecimalsRatio,
              )

            const totalBridgedTbtc = depositTwoAmount + depositThreeAmount
            const totalNewTbtc = totalBridgedTbtc * wbtcToTbtcDecimalsRatio

            await expect(tx).to.changeTokenBalance(
              TBTC,
              mezoBridge,
              totalNewTbtc,
            )
            await expect(tx).to.changeTokenBalance(TBTC, portal, -totalNewTbtc)
          })
        })

        context("when deposit has receipt minted and not repaid", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal
              .connect(depositorThree)
              .mintReceipt(wbtcAddress, depositThreeId, depositThreeAmount / 2n)

            tx = await portal
              .connect(autoBridgeCoordinator)
              .autoBridgeWbtcDeposits([
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
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should skip the deposit", async () => {
            await expect(tx)
              .to.emit(portal, "ReceiptMintedDepositAutoBridgingSkipped")
              .withArgs(depositorThree.address, wbtcAddress, depositThreeId)

            expect(await mezoBridge.sequence()).to.eq(2) // 2 deposits bridged
          })

          it("should bridge other deposits", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                1,
                depositorOne.address,
                tbtcAddress,
                depositOneAmount * wbtcToTbtcDecimalsRatio,
              )
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                2,
                depositorTwo.address,
                tbtcAddress,
                depositTwoAmount * wbtcToTbtcDecimalsRatio,
              )

            const totalBridgedTbtc = depositOneAmount + depositTwoAmount
            const totalNewTbtc = totalBridgedTbtc * wbtcToTbtcDecimalsRatio

            await expect(tx).to.changeTokenBalance(
              TBTC,
              mezoBridge,
              totalNewTbtc,
            )
            await expect(tx).to.changeTokenBalance(TBTC, portal, -totalNewTbtc)
          })
        })

        context("when called for the same deposit second time", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal.connect(autoBridgeCoordinator).autoBridgeWbtcDeposits([
              {
                depositor: depositorOne.address,
                depositId: depositOneId,
              },
              {
                depositor: depositorTwo.address,
                depositId: depositTwoId,
              },
            ])

            tx = await portal
              .connect(autoBridgeCoordinator)
              .autoBridgeWbtcDeposits([
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

          it("should skip the deposit", async () => {
            await expect(tx)
              .to.emit(portal, "WithdrawnDepositAutoBridgingSkipped")
              .withArgs(depositorTwo.address, wbtcAddress, depositTwoId)
          })

          it("should bridge other deposit", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(
                3,
                depositorThree.address,
                tbtcAddress,
                depositThreeAmount * wbtcToTbtcDecimalsRatio,
              )

            const totalBridgedTbtc = depositThreeAmount
            const totalNewTbtc = totalBridgedTbtc * wbtcToTbtcDecimalsRatio

            await expect(tx).to.changeTokenBalance(
              TBTC,
              mezoBridge,
              totalNewTbtc,
            )
            await expect(tx).to.changeTokenBalance(TBTC, portal, -totalNewTbtc)

            // 3 deposit bridged total, in the first and the second tx
            expect(await mezoBridge.sequence()).to.eq(3)
          })
        })
      })
    })
  })
})
