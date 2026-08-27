import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, MockSTBTC, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - withdrawPartially method", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let stBTC: MockSTBTC
  let tbtcAddress: string
  let usdcAddress: string
  let stbtcAddress: string
  let otherAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositId = 1
  const noLockPeriod = 0
  const minLockPeriod = 60 * 60 * 24 * 28 // 4 weeks
  const depositAmount = ethers.parseEther("1")
  const withdrawAmount = depositAmount / 2n
  const depositAmountLeft = depositAmount - withdrawAmount

  before(async () => {
    ;({
      TBTC,
      USDC,
      stBTC,
      tbtcAddress,
      usdcAddress,
      stbtcAddress,
      otherAddress,
      portal,
      deployer,
      thirdParty,
      depositorOne,
    } = await loadFixture(deployPortal))
  })

  describe("withdrawPartially", () => {
    context("when token is not supported", () => {
      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(otherAddress, depositId, depositAmount),
        )
          .to.be.revertedWithCustomError(portal, "TokenNotSupported")
          .withArgs(otherAddress)
      })
    })

    context("when amount deposited is 0", () => {
      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, depositAmount),
        ).to.be.revertedWithCustomError(portal, "DepositNotFound")
      })
    })

    context("when amount to withdraw is 0", () => {
      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, 0),
        )
          .to.be.revertedWithCustomError(portal, "IncorrectAmount")
          .withArgs(0)
      })
    })

    context("when amount is equal to the deposited balance", () => {
      before(async () => {
        await createSnapshot()

        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, noLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, depositAmount),
        )
          .to.be.revertedWithCustomError(
            portal,
            "PartialWithdrawalAmountTooHigh",
          )
          .withArgs(depositAmount)
      })
    })

    context("when amount is greater than deposited balance", () => {
      before(async () => {
        await createSnapshot()

        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, noLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, depositAmount + 1n),
        )
          .to.be.revertedWithCustomError(
            portal,
            "PartialWithdrawalAmountTooHigh",
          )
          .withArgs(depositAmount)
      })
    })

    context("when minted receipt tokens are not repaid", () => {
      const receiptMinted = depositAmount / 4n

      before(async () => {
        await createSnapshot()

        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, noLockPeriod)

        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 0, 100, stbtcAddress)

        await portal
          .connect(depositorOne)
          .mintReceipt(tbtcAddress, depositId, receiptMinted)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, withdrawAmount),
        )
          .to.be.revertedWithCustomError(portal, "ReceiptNotRepaid")
          .withArgs(receiptMinted)
      })
    })

    context(
      "when minted receipt tokens are repaid but there is a fee owed",
      () => {
        const receiptMinted = depositAmount

        before(async () => {
          await createSnapshot()

          await TBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, noLockPeriod)

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 20, 100, stbtcAddress)

          await portal
            .connect(depositorOne)
            .mintReceipt(tbtcAddress, depositId, receiptMinted)

          await helpers.time.increaseTime(60 * 86400) // 60 days

          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), receiptMinted)
          await portal
            .connect(depositorOne)
            .repayReceipt(tbtcAddress, depositId, receiptMinted)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
          )

          // 60 days, 20% fee, and 1 stBTC minted:
          // (1 * 0.2) * (60 / 365) = ~0.0328767
          // Precise fee calculations are covered in the repay function unit
          // tests. Here we just ensure the fee is ~0.03 to make sure the
          // fee is non-zero or too low when testing to avoid false positives.
          const expectedFee = 30000000000000000n // 0.03
          expect(deposit.feeOwed).to.be.closeTo(
            expectedFee,
            5000000000000000, // 0.005 tolerance
          )

          await expect(
            portal
              .connect(depositorOne)
              .withdrawPartially(tbtcAddress, depositId, withdrawAmount),
          )
            .to.be.revertedWithCustomError(portal, "ReceiptFeeOwed")
            .withArgs(deposit.feeOwed)
        })
      },
    )

    context("when deposit is not locked", () => {
      context("when the token being withdrawn is not lockable", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal.connect(deployer).addSupportedToken({
            token: usdcAddress,
            tokenAbility: TokenAbility.Deposit,
          })

          await USDC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(usdcAddress, depositAmount, noLockPeriod)

          // Withdraw half of the deposited amount
          tx = await portal
            .connect(depositorOne)
            .withdrawPartially(usdcAddress, depositId, withdrawAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              usdcAddress,
              depositId,
              withdrawAmount,
            )
        })

        it("should decrease the deposited balance", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                usdcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(depositAmountLeft)
        })

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            USDC,
            depositorOne.address,
            withdrawAmount,
          )
        })

        it("should allow to withdraw the remaining balance later", async () => {
          await portal.connect(depositorOne).withdraw(usdcAddress, depositId)

          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                usdcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(0)

          await expect(tx).to.changeTokenBalance(
            USDC,
            depositorOne.address,
            depositAmountLeft,
          )
        })
      })

      context("when the token being withdrawn is lockable", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await TBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, noLockPeriod)

          // Withdraw half of the deposited amount
          tx = await portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, withdrawAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              withdrawAmount,
            )
        })

        it("should decrease the deposited balance", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(depositAmountLeft)
        })

        it("should transfer the token to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            withdrawAmount,
          )
        })

        it("should allow to withdraw the remaining balance later", async () => {
          await portal.connect(depositorOne).withdraw(tbtcAddress, depositId)

          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(0)

          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmountLeft,
          )
        })
      })
    })

    context("when deposit is locked", () => {
      let unlockAt: number

      before(async () => {
        await createSnapshot()

        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, minLockPeriod)

        unlockAt = (await helpers.time.lastBlockTime()) + minLockPeriod
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when lock time has not passed", () => {
        context("when deposit global unlock at timestamp is not set", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(depositorOne)
                .withdrawPartially(tbtcAddress, depositId, withdrawAmount),
            )
              .to.be.revertedWithCustomError(portal, "DepositLocked")
              .withArgs(unlockAt)
          })
        })

        context("when deposit global unlock at timestamp is set", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal.setDepositGlobalUnlockAt(
              await helpers.time.lastBlockTime(),
            )

            tx = await portal
              .connect(depositorOne)
              .withdrawPartially(tbtcAddress, depositId, withdrawAmount)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit Withdrawn event", async () => {
            await expect(tx)
              .to.emit(portal, "Withdrawn")
              .withArgs(
                depositorOne.address,
                tbtcAddress,
                depositId,
                withdrawAmount,
              )
          })

          it("should decrease the deposited balance", async () => {
            expect(
              (
                await portal.getDeposit(
                  depositorOne.address,
                  tbtcAddress,
                  depositId,
                )
              ).balance,
            ).to.equal(depositAmountLeft)
          })

          it("should transfer tokens to the user", async () => {
            await expect(tx).to.changeTokenBalance(
              TBTC,
              depositorOne.address,
              withdrawAmount,
            )
          })

          it("should allow to withdraw the remaining balance later", async () => {
            await portal.connect(depositorOne).withdraw(tbtcAddress, depositId)

            expect(
              (
                await portal.getDeposit(
                  depositorOne.address,
                  tbtcAddress,
                  depositId,
                )
              ).balance,
            ).to.equal(0)

            await expect(tx).to.changeTokenBalance(
              TBTC,
              depositorOne.address,
              depositAmountLeft,
            )
          })
        })
      })

      context("when lock time has passed", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await helpers.time.increaseTime(minLockPeriod + 1)

          tx = await portal
            .connect(depositorOne)
            .withdrawPartially(tbtcAddress, depositId, withdrawAmount)
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              withdrawAmount,
            )
        })

        it("should decrease the deposited balance", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(depositAmountLeft)
        })

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            withdrawAmount,
          )
        })

        it("should allow to withdraw the remaining balance later", async () => {
          await portal.connect(depositorOne).withdraw(tbtcAddress, depositId)

          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).balance,
          ).to.equal(0)

          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmountLeft,
          )
        })
      })
    })

    context("when withdrawing funds deposited by someone else", () => {
      context("when called by the deposit funder", () => {
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal
              .connect(thirdParty)
              .withdrawPartially(tbtcAddress, depositId, withdrawAmount),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when called by the deposit owner", () => {
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
            .withdrawPartially(tbtcAddress, depositId, withdrawAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              withdrawAmount,
            )
        })

        it("should transfer the token to the deposit owner", async () => {
          await expect(tx).to.changeTokenBalances(
            TBTC,
            [await portal.getAddress(), depositorOne.address],
            [-depositAmountLeft, depositAmountLeft],
          )
        })
      })
    })
  })
})
