import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import {
  to1e18,
  to1ePrecision,
} from "@keep-network/hardhat-helpers/dist/number"
import { MockERC20, MockSTBTC, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TbtcMigrationState, TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - withdraw method", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let WBTC: MockERC20
  let stBTC: MockSTBTC
  let tbtcAddress: string
  let wbtcAddress: string
  let usdcAddress: string
  let stbtcAddress: string
  let otherAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const noLockPeriod = 0
  const minLockPeriod = 60 * 60 * 24 * 28 // 4 weeks
  const depositAmount = ethers.parseEther("1")
  const depositId = 1

  before(async () => {
    ;({
      TBTC,
      WBTC,
      USDC,
      stBTC,
      tbtcAddress,
      wbtcAddress,
      usdcAddress,
      stbtcAddress,
      otherAddress,
      portal,
      deployer,
      thirdParty,
      depositorOne,
    } = await loadFixture(deployPortal))
  })

  describe("withdraw", () => {
    context("when token is not supported", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(depositorOne).withdraw(otherAddress, depositId),
        )
          .to.be.revertedWithCustomError(portal, "TokenNotSupported")
          .withArgs(otherAddress)
      })
    })

    context("when amount deposited is 0", () => {
      it("should revert", async () => {
        await expect(
          portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
        ).to.be.revertedWithCustomError(portal, "DepositNotFound")
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
          portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
        )
          .to.be.revertedWithCustomError(portal, "ReceiptNotRepaid")
          .withArgs(receiptMinted)
      })
    })

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

          tx = await portal
            .connect(depositorOne)
            .withdraw(usdcAddress, depositId)
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
              depositAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, usdcAddress, depositId, 0)
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            usdcAddress,
            depositId,
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

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            USDC,
            depositorOne.address,
            depositAmount,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(usdcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
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

          tx = await portal
            .connect(depositorOne)
            .withdraw(tbtcAddress, depositId)
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
              depositAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, tbtcAddress, depositId, 0)
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
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

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmount,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when the token has 8 decimals", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await WBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(wbtcAddress, depositAmount, noLockPeriod)

          tx = await portal
            .connect(depositorOne)
            .withdraw(wbtcAddress, depositId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              depositId,
              depositAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, wbtcAddress, depositId, 0)
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositId,
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

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            WBTC,
            depositorOne.address,
            depositAmount,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(wbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
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
              portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
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
              .withdraw(tbtcAddress, depositId)
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
                depositAmount,
              )
          })

          it("should emit FeeCollected event", async () => {
            await expect(tx)
              .to.emit(portal, "FeeCollected")
              .withArgs(depositorOne.address, tbtcAddress, depositId, 0)
          })

          it("should delete the deposit", async () => {
            const deposit = await portal.getDeposit(
              depositorOne.address,
              tbtcAddress,
              depositId,
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

          it("should transfer tokens to the user", async () => {
            await expect(tx).to.changeTokenBalance(
              TBTC,
              depositorOne.address,
              depositAmount,
            )
          })

          it("should not allow to withdraw anything more", async () => {
            await expect(
              portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
            ).to.be.revertedWithCustomError(portal, "DepositNotFound")
          })
        })
      })

      context("when lock time has passed", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await helpers.time.increaseTime(minLockPeriod + 1)

          tx = await portal
            .connect(depositorOne)
            .withdraw(tbtcAddress, depositId)
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              depositAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, tbtcAddress, depositId, 0)
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
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

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmount,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
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
            portal.connect(thirdParty).withdraw(tbtcAddress, depositId),
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
            .withdraw(tbtcAddress, depositId)
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
              depositAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, tbtcAddress, depositId, 0)
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
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

        it("should transfer tokens to the user", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmount,
          )
        })

        it("should not allow to withdraw anything more", async () => {
          await expect(
            portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })
    })

    context("when withdrawing funds after repaying receipt tokens", () => {
      context("when withdrawing funds of a token with 18 decimals", () => {
        const receiptMinted = depositAmount / 2n
        let tx: ContractTransactionResponse
        let feeOwed: bigint

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

          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
          )

          feeOwed = deposit.feeOwed

          tx = await portal
            .connect(depositorOne)
            .withdraw(tbtcAddress, depositId)
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
              depositAmount - feeOwed,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, tbtcAddress, depositId, feeOwed)
        })

        it("should transfer tokens to the deposit owner", async () => {
          await expect(tx).to.changeTokenBalance(
            TBTC,
            await portal.getAddress(),
            -(depositAmount - feeOwed),
          )
          await expect(tx).to.changeTokenBalance(
            TBTC,
            depositorOne.address,
            depositAmount - feeOwed,
          )
        })

        it("should collect the fee", async () => {
          // 60 days, 20% fee, and 0.5 stBTC minted:
          // (0.5 * 0.2) * (60 / 365) = ~0.0164383
          // Precise fee calculations are covered in the repay function unit
          // tests. Here we just ensure the fee is ~0.016.
          const expectedFee = 16000000000000000n // 0.016
          const info = await portal.feeInfo(tbtcAddress)
          expect(info.feeCollected).to.be.closeTo(
            expectedFee,
            1000000000000000, // 0.001 tolerance
          )
          // just a sanity check for previous assertions
          expect(feeOwed).to.be.closeTo(
            expectedFee,
            1000000000000000, // 0.001 tolerance
          )
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
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
            portal.connect(depositorOne).withdraw(tbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when withdrawing funds of a token with 8 decimals", () => {
        const wbtcDepositAmount = to1ePrecision(1, 8) // 1 WBTC
        const receiptMinted = to1e18(1) / 2n // half of the deposit, 0.5 stBTC
        let tx: ContractTransactionResponse
        let feeOwed: bigint
        let expectedWithdrawAmount: bigint

        before(async () => {
          await createSnapshot()

          await WBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            wbtcDepositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(wbtcAddress, wbtcDepositAmount, noLockPeriod)

          await portal
            .connect(deployer)
            .setReceiptParams(wbtcAddress, 20, 100, stbtcAddress)
          await portal
            .connect(depositorOne)
            .mintReceipt(wbtcAddress, depositId, receiptMinted)

          await helpers.time.increaseTime(60 * 86400) // 60 days

          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), receiptMinted)
          await portal
            .connect(depositorOne)
            .repayReceipt(wbtcAddress, depositId, receiptMinted)

          const deposit = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositId,
          )

          // feeOwed is using 18 decimals because the receipt token has 18 decimals,
          // so to subtract from wbtcDepositAmount that is using 8 decimals we need
          // to adjust feeOwed precision first
          feeOwed = deposit.feeOwed / 10n ** 10n
          expectedWithdrawAmount = wbtcDepositAmount - feeOwed

          tx = await portal
            .connect(depositorOne)
            .withdraw(wbtcAddress, depositId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Withdrawn event", async () => {
          await expect(tx)
            .to.emit(portal, "Withdrawn")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              depositId,
              expectedWithdrawAmount,
            )
        })

        it("should emit FeeCollected event", async () => {
          await expect(tx)
            .to.emit(portal, "FeeCollected")
            .withArgs(depositorOne.address, wbtcAddress, depositId, feeOwed)
        })

        it("should transfer tokens to the deposit owner", async () => {
          await expect(tx).to.changeTokenBalance(
            WBTC,
            await portal.getAddress(),
            -expectedWithdrawAmount,
          )
          await expect(tx).to.changeTokenBalance(
            WBTC,
            depositorOne.address,
            expectedWithdrawAmount,
          )
        })

        it("should collect the fee", async () => {
          // 60 days, 20% fee, and 0.5 stBTC minted:
          // (0.5 * 0.2) * (60 / 365) = ~0.0164383
          // Precise fee calculations are covered in the repay function unit
          // tests. Here we just ensure the fee is ~0.016.
          const expectedFee = 1600000n // 0.016
          const info = await portal.feeInfo(wbtcAddress)

          expect(info.feeCollected).to.be.closeTo(
            expectedFee,
            1000000000000000, // 0.001 tolerance
          )
          // just a sanity check for previous assertions
          expect(feeOwed).to.be.closeTo(
            expectedFee,
            1000000000000000, // 0.001 tolerance
          )
        })

        it("should delete the deposit", async () => {
          const deposit = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositId,
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
            portal.connect(depositorOne).withdraw(wbtcAddress, depositId),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })
    })
  })
})
