import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse, ZeroAddress } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MezoBridge, MockERC20, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - auto-bridging", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let tbtcAddress: string
  let wbtcAddress: string
  let usdcAddress: string
  let stbtcAddress: string
  let portal: Portal
  let mezoBridge: MezoBridge
  let deployer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner
  let autoBridgeCoordinator: HardhatEthersSigner

  const noLockPeriod = 0
  const depositAmount = ethers.parseEther("1")
  const depositId = 1
  const mintLimit = 50 // 50%
  const mintAmount = depositAmount / 4n

  before(async () => {
    ;({
      TBTC,
      USDC,
      tbtcAddress,
      wbtcAddress,
      usdcAddress,
      stbtcAddress,
      portal,
      mezoBridge,
      deployer,
      thirdParty,
      depositorOne,
      depositorTwo,
      autoBridgeCoordinator,
    } = await loadFixture(deployPortal))

    await portal.setTbtcTokenAddress(tbtcAddress)
    await portal.addSupportedToken({
      token: usdcAddress,
      tokenAbility: TokenAbility.DepositAndLock,
    })
    await portal.setReceiptParams(usdcAddress, 5, mintLimit, stbtcAddress)
    await portal.setAssetTbtcMigrationAllowed(usdcAddress, true)
    await mezoBridge.enableERC20Token(usdcAddress, 10000)
  })

  describe("setMezoBridge", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setMezoBridge(ZeroAddress),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the contract's owner", () => {
      context("when called with zero address as Mezo bridge", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).setMezoBridge(ZeroAddress),
          ).to.be.revertedWithCustomError(portal, "IncorrectMezoBridgeAddress")
        })
      })
    })

    context("when called with non-zero address as Mezo bridge", () => {
      const newMezoBridge = "0x1111111111111111111111111111111111111111"
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await portal.connect(deployer).setMezoBridge(newMezoBridge)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set Mezo bridge address", async () => {
        expect(await portal.mezoBridge()).to.equal(newMezoBridge)
      })

      it("should emit MezoBridgeAddressSet event", async () => {
        await expect(tx)
          .to.emit(portal, "MezoBridgeUpdated")
          .withArgs(ZeroAddress, newMezoBridge)
      })
    })
  })

  describe("setAutoBridgeCoordinator", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setAutoBridgeCoordinator(thirdParty),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the contract's owner", () => {
      context(
        "when called with zero address as auto-bridging coordinator",
        () => {
          it("should revert", async () => {
            await expect(
              portal.connect(deployer).setAutoBridgeCoordinator(ZeroAddress),
            ).to.be.revertedWithCustomError(
              portal,
              "IncorrectAutoBridgeCoordinatorAddress",
            )
          })
        },
      )
    })

    context(
      "when called with non-zero address as auto-bridging coordinator",
      () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await portal
            .connect(deployer)
            .setAutoBridgeCoordinator(thirdParty)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set auto-bridging coordinator", async () => {
          expect(await portal.autoBridgeCoordinator()).to.equal(thirdParty)
        })

        it("should emit AutoBridgeCoordinatorUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "AutoBridgeCoordinatorUpdated")
            .withArgs(autoBridgeCoordinator, thirdParty)
        })
      },
    )
  })

  describe("setDepositGlobalUnlockAt", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setDepositGlobalUnlockAt(50000000),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the contract's owner", () => {
      context(
        "when called with zero as deposit global unlock at timestamp",
        () => {
          it("should revert", async () => {
            await expect(
              portal.connect(deployer).setDepositGlobalUnlockAt(0),
            ).to.be.revertedWithCustomError(
              portal,
              "IncorrectDepositGlobalUnlockAt",
            )
          })
        },
      )
    })

    context(
      "when called with non-zero value as deposit global unlock at timestamp",
      () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await portal.connect(deployer).setDepositGlobalUnlockAt(50000000)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set deposit global unlock at timestamp", async () => {
          expect(await portal.depositGlobalUnlockAt()).to.equal(50000000)
        })

        it("should emit DepositGlobalUnlockAtUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "DepositGlobalUnlockAtUpdated")
            .withArgs(0, 50000000)
        })
      },
    )
  })

  describe("setWbtcTokenAddress", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setWbtcTokenAddress(ZeroAddress),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the contract's owner", () => {
      context("when called with zero address as WBTC token", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).setWbtcTokenAddress(ZeroAddress),
          ).to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
        })
      })
    })

    context("when called with non-zero WBTC token address", () => {
      const newWbtcAddress = "0x1111111111111111111111111111111111111111"
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await portal.connect(deployer).setWbtcTokenAddress(newWbtcAddress)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set WBTC token address", async () => {
        expect(await portal.wbtcToken()).to.equal(newWbtcAddress)
      })

      it("should emit WbtcTokenAddressSet event", async () => {
        await expect(tx)
          .to.emit(portal, "WbtcTokenAddressSet")
          .withArgs(newWbtcAddress)
      })
    })
  })

  describe("setDepositAutoBridgingOptOut - contract's owner version", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal
            .connect(thirdParty)
            ["setDepositAutoBridgingOptOut(address,address,uint256,bool)"](
              depositorOne.address,
              tbtcAddress,
              depositId,
              true,
            ),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the contract's owner", () => {
      context("when deposit does not exist", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(deployer)
              ["setDepositAutoBridgingOptOut(address,address,uint256,bool)"](
                depositorOne.address,
                tbtcAddress,
                depositId,
                true,
              ),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when deposit exists", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await TBTC.connect(thirdParty).approve(
            await portal.getAddress(),
            depositAmount,
          )

          await portal
            .connect(thirdParty)
            .depositFor(
              depositorOne.address,
              tbtcAddress,
              depositAmount,
              noLockPeriod,
            )

          tx = await portal
            .connect(deployer)
            ["setDepositAutoBridgingOptOut(address,address,uint256,bool)"](
              depositorOne.address,
              tbtcAddress,
              depositId,
              true,
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the deposit's auto-bridging opt-out as true", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
          )

          expect(deposit.autoBridgingOptOut).to.equal(true)
        })

        it("should emit DepositAutoBridgingOptOutSet event", async () => {
          await expect(tx)
            .to.emit(portal, "DepositAutoBridgingOptOutSet")
            .withArgs(depositorOne.address, tbtcAddress, depositId, true)
        })
      })
    })
  })

  describe("setDepositAutoBridgingOptOut - deposit's owner version", () => {
    context("when deposit does not exist", () => {
      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            ["setDepositAutoBridgingOptOut(address,uint256,bool)"](
              tbtcAddress,
              depositId,
              true,
            ),
        ).to.be.revertedWithCustomError(portal, "DepositNotFound")
      })
    })

    context("when deposit exists", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await TBTC.connect(thirdParty).approve(
          await portal.getAddress(),
          depositAmount,
        )

        await portal
          .connect(thirdParty)
          .depositFor(
            depositorOne.address,
            tbtcAddress,
            depositAmount,
            noLockPeriod,
          )

        tx = await portal
          .connect(depositorOne)
          ["setDepositAutoBridgingOptOut(address,uint256,bool)"](
            tbtcAddress,
            depositId,
            true,
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the deposit's auto-bridging opt-out as true", async () => {
        const deposit = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          depositId,
        )

        expect(deposit.autoBridgingOptOut).to.equal(true)
      })

      it("should emit DepositAutoBridgingOptOutSet event", async () => {
        await expect(tx)
          .to.emit(portal, "DepositAutoBridgingOptOutSet")
          .withArgs(depositorOne.address, tbtcAddress, depositId, true)
      })
    })
  })

  describe("autoBridgeDeposits", () => {
    context("when called by third party", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).autoBridgeDeposits(tbtcAddress, [
            {
              depositor: depositorOne,
              depositId: 1,
            },
          ]),
        ).to.be.revertedWithCustomError(
          portal,
          "CallerNotAutoBridgeCoordinator",
        )
      })
    })

    context("when called by auto-bridge-coordinator", () => {
      context("when WBTC token address has not been set", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(autoBridgeCoordinator)
              .autoBridgeDeposits(wbtcAddress, [
                {
                  depositor: depositorOne,
                  depositId: 1,
                },
              ]),
          )
            .to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
            .withArgs(ZeroAddress)
        })
      })

      context("when WBTC token address has been set", () => {
        before(async () => {
          await createSnapshot()

          await portal.setWbtcTokenAddress(wbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when Mezo bridge address has not been set", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(autoBridgeCoordinator)
                .autoBridgeDeposits(wbtcAddress, [
                  {
                    depositor: depositorOne,
                    depositId: 1,
                  },
                ]),
            )
              .to.be.revertedWithCustomError(
                portal,
                "IncorrectMezoBridgeAddress",
              )
              .withArgs(ZeroAddress)
          })
        })

        context("when Mezo bridge has been set", () => {
          before(async () => {
            await createSnapshot()

            await portal.setMezoBridge(mezoBridge)
          })

          after(async () => {
            await restoreSnapshot()
          })

          context("when called with WBTC token", () => {
            it("should revert", async () => {
              await expect(
                portal
                  .connect(autoBridgeCoordinator)
                  .autoBridgeDeposits(wbtcAddress, [
                    {
                      depositor: depositorOne,
                      depositId: 1,
                    },
                  ]),
              ).to.be.revertedWithCustomError(
                portal,
                "WbtcAutoBridgingNotSupported",
              )
            })
          })

          context("when called with bridgeable ERC20 token", () => {
            let tx: ContractTransactionResponse
            let initPortalUsdcBalance: bigint
            let initialMezoBridgeUsdcBalance: bigint

            before(async () => {
              await createSnapshot()

              await USDC.connect(thirdParty).approve(
                await portal.getAddress(),
                depositAmount * 5n, // 5 deposits created
              )

              // Deposit 1 - bridgeable
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  usdcAddress,
                  depositAmount,
                  noLockPeriod,
                )

              // Deposit 2 - not bridgeable - marked as opting-out
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  usdcAddress,
                  depositAmount,
                  noLockPeriod,
                )
              await portal
                .connect(depositorOne)
                ["setDepositAutoBridgingOptOut(address,uint256,bool)"](
                  usdcAddress,
                  2,
                  true,
                )

              // Deposit 3 - not bridgeable - stBTC minted and not repaid
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  usdcAddress,
                  depositAmount,
                  noLockPeriod,
                )
              await portal
                .connect(depositorOne)
                .mintReceipt(usdcAddress, 3, mintAmount)

              // Deposit 4 - not bridgeable - to-tBTC migration requested
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  usdcAddress,
                  depositAmount,
                  noLockPeriod,
                )
              await portal
                .connect(depositorOne)
                .requestTbtcMigration(usdcAddress, 4)

              // Deposit 5 - bridgeable
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorTwo.address,
                  usdcAddress,
                  depositAmount,
                  noLockPeriod,
                )

              // Deposit 6 - not bridgeable - deposit does not exist

              initPortalUsdcBalance = await USDC.balanceOf(portal)
              initialMezoBridgeUsdcBalance = await USDC.balanceOf(mezoBridge)

              tx = await portal
                .connect(autoBridgeCoordinator)
                .autoBridgeDeposits(usdcAddress, [
                  {
                    depositor: depositorOne.address,
                    depositId: 1,
                  },
                  {
                    depositor: depositorOne.address,
                    depositId: 2,
                  },
                  {
                    depositor: depositorOne.address,
                    depositId: 3,
                  },
                  {
                    depositor: depositorOne.address,
                    depositId: 4,
                  },
                  {
                    depositor: depositorTwo.address,
                    depositId: 5,
                  },
                  {
                    depositor: depositorOne.address,
                    depositId: 6,
                  },
                ])
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should remove deposit 1 and 5", async () => {
              expect(
                (await portal.getDeposit(depositorOne.address, usdcAddress, 1))
                  .balance,
              ).to.equal(0)
              expect(
                (await portal.getDeposit(depositorTwo.address, usdcAddress, 5))
                  .balance,
              ).to.equal(0)
            })

            it("should transfer tokens from Portal to MezoBridge", async () => {
              const usdcBalanceChange = depositAmount * 2n // two deposits bridged
              expect(
                (await USDC.balanceOf(portal)) - initPortalUsdcBalance,
              ).to.equal(-usdcBalanceChange)
              expect(
                (await USDC.balanceOf(mezoBridge)) -
                  initialMezoBridgeUsdcBalance,
              ).to.equal(usdcBalanceChange)
            })

            it("should emit DepositAutoBridged event for deposits 1 and 5", async () => {
              await expect(tx)
                .to.emit(portal, "DepositAutoBridged")
                .withArgs(depositorOne.address, usdcAddress, 1, depositAmount)
              await expect(tx)
                .to.emit(portal, "DepositAutoBridged")
                .withArgs(depositorTwo.address, usdcAddress, 5, depositAmount)
            })

            it("should emit AssetsLocked event for deposit 1 and 5", async () => {
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(1, depositorOne.address, usdcAddress, depositAmount)
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(2, depositorTwo.address, usdcAddress, depositAmount)
            })

            it("should emit OptOutDepositAutoBridgingSkipped event for deposit 2", async () => {
              await expect(tx)
                .to.emit(portal, "OptOutDepositAutoBridgingSkipped")
                .withArgs(depositorOne.address, usdcAddress, 2)
            })

            it("should emit ReceiptMintedDepositAutoBridgingSkipped event for deposit 3", async () => {
              await expect(tx)
                .to.emit(portal, "ReceiptMintedDepositAutoBridgingSkipped")
                .withArgs(depositorOne.address, usdcAddress, 3)
            })

            it("should emit TbtcMigratingDepositAutoBridgingSkipped event for deposit 4", async () => {
              await expect(tx)
                .to.emit(portal, "TbtcMigratingDepositAutoBridgingSkipped")
                .withArgs(depositorOne.address, usdcAddress, 4)
            })

            it("should emit WithdrawnDepositAutoBridgingSkipped event for deposit 6", async () => {
              await expect(tx)
                .to.emit(portal, "WithdrawnDepositAutoBridgingSkipped")
                .withArgs(depositorOne.address, usdcAddress, 6)
            })
          })

          context("when called with tBTC token", () => {
            // In case of tTBTC auto-bridging we only test scenario with bridgeable
            // deposits. The non-bridgeable deposits are handled the same way as for
            // other ERC20 tokens.
            let tx: ContractTransactionResponse
            let initPortalTbtcBalance: bigint
            let initialMezoBridgeTbtcBalance: bigint

            before(async () => {
              await createSnapshot()

              await TBTC.connect(thirdParty).approve(
                await portal.getAddress(),
                depositAmount * 2n, // 2 deposits created
              )

              // Deposit 1 - bridgeable
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  tbtcAddress,
                  depositAmount,
                  noLockPeriod,
                )

              // Deposit 2 - bridgeable
              await portal
                .connect(thirdParty)
                .depositFor(
                  depositorTwo.address,
                  tbtcAddress,
                  depositAmount,
                  noLockPeriod,
                )

              initPortalTbtcBalance = await TBTC.balanceOf(portal)
              initialMezoBridgeTbtcBalance = await TBTC.balanceOf(mezoBridge)

              tx = await portal
                .connect(autoBridgeCoordinator)
                .autoBridgeDeposits(tbtcAddress, [
                  {
                    depositor: depositorOne.address,
                    depositId: 1,
                  },
                  {
                    depositor: depositorTwo.address,
                    depositId: 2,
                  },
                ])
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should remove both deposits", async () => {
              expect(
                (await portal.getDeposit(depositorOne.address, tbtcAddress, 1))
                  .balance,
              ).to.equal(0)
              expect(
                (await portal.getDeposit(depositorTwo.address, tbtcAddress, 2))
                  .balance,
              ).to.equal(0)
            })

            it("should transfer tokens from Portal to MezoBridge", async () => {
              const tbtcBalanceChange = depositAmount * 2n // two deposits bridged
              expect(
                (await TBTC.balanceOf(portal)) - initPortalTbtcBalance,
              ).to.equal(-tbtcBalanceChange)
              expect(
                (await TBTC.balanceOf(mezoBridge)) -
                  initialMezoBridgeTbtcBalance,
              ).to.equal(tbtcBalanceChange)
            })

            it("should emit DepositAutoBridged event for both deposits", async () => {
              await expect(tx)
                .to.emit(portal, "DepositAutoBridged")
                .withArgs(depositorOne.address, tbtcAddress, 1, depositAmount)
              await expect(tx)
                .to.emit(portal, "DepositAutoBridged")
                .withArgs(depositorTwo.address, tbtcAddress, 2, depositAmount)
            })

            it("should emit AssetsLocked event for both deposits", async () => {
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(1, depositorOne.address, tbtcAddress, depositAmount)
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(2, depositorTwo.address, tbtcAddress, depositAmount)
            })
          })
        })
      })
    })
  })
})
