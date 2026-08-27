import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse, ZeroAddress } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import {
  to1e18,
  to1ePrecision,
} from "@keep-network/hardhat-helpers/dist/number"
import { MockERC20, MockSTBTC, MockWBTC, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - repayReceipt method", () => {
  let TBTC: MockERC20
  let WBTC: MockWBTC
  let stBTC: MockSTBTC
  let tbtcAddress: string
  let wbtcAddress: string
  let stbtcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner

  const noLockPeriod = 0

  before(async () => {
    ;({
      TBTC,
      WBTC,
      tbtcAddress,
      wbtcAddress,
      stBTC,
      stbtcAddress,
      portal,
      deployer,
      depositorOne,
      depositorTwo,
    } = await loadFixture(deployPortal))

    await portal
      .connect(deployer)
      .setReceiptParams(tbtcAddress, 5, 100, stbtcAddress)
  })

  describe("repayReceipt", () => {
    context("when called incorrectly", () => {
      const depositAmount = to1e18(1)
      const depositId = 1

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

      context("when minting is disabled for token", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .repayReceipt(stbtcAddress, depositId, depositAmount),
          ).to.be.revertedWithCustomError(portal, "ReceiptMintingDisabled")
        })
      })

      context("when amount is zero", async () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .repayReceipt(tbtcAddress, depositId, 0),
          ).to.be.revertedWithCustomError(portal, "IncorrectAmount")
        })
      })

      context("when deposit is not found", () => {
        const unknownDepositID = 1337

        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .repayReceipt(tbtcAddress, unknownDepositID, depositAmount),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when trying to repay without minting anything", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .repayReceipt(tbtcAddress, depositId, depositAmount),
          )
            .to.be.revertedWithCustomError(portal, "RepayAmountExceededDebt")
            .withArgs(0, depositAmount)
        })
      })

      context("when trying to repay more than minted", () => {
        const mintedReceipt = depositAmount / 2n

        before(async () => {
          await createSnapshot()

          await portal
            .connect(depositorOne)
            .mintReceipt(tbtcAddress, depositId, mintedReceipt)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          const depositInfo = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
          )

          await expect(
            portal
              .connect(depositorOne)
              .repayReceipt(tbtcAddress, depositId, mintedReceipt + 1n),
          )
            .to.be.revertedWithCustomError(portal, "RepayAmountExceededDebt")
            .withArgs(depositInfo.receiptMinted, mintedReceipt + 1n)
        })
      })
    })

    context("when called correctly", () => {
      const depositAmount = to1e18(10)

      const depositorOneReceiptMinted = to1e18(5)
      const depositorTwoReceiptMinted = to1e18(10)

      const depositorOneDepositId = 1
      const depositorTwoDepositId = 2

      // We assert with 0.000001 precision. Asserting specific amounts is
      // possible but complicated given the block mining times and the order
      // of transactions. This would make the test very fragile and hard to
      // follow.
      const precision = 1000000000000 // 0.000001 in 1e18 precision

      // Helper function to assert feeOwed value for both depositors.
      // Let's use not repeat the same code over and over again.
      const assertFeeOwed = async (
        expectedDepositorOneFee: bigint,
        expectedDepositorTwoFee: bigint,
      ) => {
        const depositOne = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          depositorOneDepositId,
        )

        const depositTwo = await portal.getDeposit(
          depositorTwo.address,
          tbtcAddress,
          depositorTwoDepositId,
        )

        expect(depositOne.feeOwed).to.be.closeTo(
          expectedDepositorOneFee,
          precision,
        )
        expect(depositTwo.feeOwed).to.be.closeTo(
          expectedDepositorTwoFee,
          precision,
        )
      }

      before(async () => {
        await createSnapshot()

        // The first and the second depositor deposit 10 tBTC each.
        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await TBTC.connect(depositorTwo).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, noLockPeriod)
        await portal
          .connect(depositorTwo)
          .deposit(tbtcAddress, depositAmount, noLockPeriod)

        // The fee for minting stBTC is 5%
        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 5, 100, stbtcAddress)

        // The first depositors mints 5 stBTC, the second depositor mints 10 stBTC
        await portal
          .connect(depositorOne)
          .mintReceipt(
            tbtcAddress,
            depositorOneDepositId,
            depositorOneReceiptMinted,
          )
        await portal
          .connect(depositorTwo)
          .mintReceipt(
            tbtcAddress,
            depositorTwoDepositId,
            depositorTwoReceiptMinted,
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when repaying partially", () => {
        const depositorOneRepayment = to1e18(1)
        const depositorTwoRepayment = to1e18(5)

        let txDepositorOne: ContractTransactionResponse
        let txDepositorTwo: ContractTransactionResponse

        // After 60 days, the first depositor repays partially with 1stBTC.
        // After another 30 days, the second depositor repays partially with
        // 5 stBTC.
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days
          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), depositorOneRepayment)
          txDepositorOne = await portal
            .connect(depositorOne)
            .repayReceipt(
              tbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await helpers.time.increaseTime(30 * 86400) // 30 days
          await stBTC
            .connect(depositorTwo)
            .approve(await portal.getAddress(), depositorTwoRepayment)
          txDepositorTwo = await portal
            .connect(depositorTwo)
            .repayReceipt(
              tbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })

        it("should correctly calculate the fee owed", async () => {
          // 60 days, 5% fee, and 5 stBTC minted:
          // (5 * 0.05) * (60 / 365) = ~0.0410958
          //
          // 90 days, 5% fee, and 10 stBTC minted:
          // (10 * 0.05) * (90 / 365) = ~0.1232876
          await assertFeeOwed(41095800000000000n, 123287600000000000n)
        })

        it("should transfer receipt tokens away and burn them", async () => {
          await expect(txDepositorOne).to.changeTokenBalance(
            stBTC,
            depositorOne.address,
            -depositorOneRepayment,
          )
          await expect(txDepositorOne)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo).to.changeTokenBalance(
            stBTC,
            depositorTwo.address,
            -depositorTwoRepayment,
          )
          await expect(txDepositorTwo)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorTwoRepayment,
            )
        })

        it("should update receipt minted for deposit", async () => {
          const depositOneAfter = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositorOneDepositId,
          )

          expect(depositOneAfter.receiptMinted).to.equal(
            depositorOneReceiptMinted - depositorOneRepayment,
          )

          const depositTwoAfter = await portal.getDeposit(
            depositorTwo.address,
            tbtcAddress,
            depositorTwoDepositId,
          )

          expect(depositTwoAfter.receiptMinted).to.equal(
            depositorTwoReceiptMinted - depositorTwoRepayment,
          )
        })

        it("should update total minted", async () => {
          const feeInfo = await portal.feeInfo(tbtcAddress)
          expect(feeInfo.totalMinted).to.equal(
            depositorOneReceiptMinted +
              depositorTwoReceiptMinted -
              depositorOneRepayment -
              depositorTwoRepayment,
          )
        })

        it("should emit DepositRepaid event", async () => {
          await expect(txDepositorOne)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorTwo.address,
              tbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })
      })

      context("when repaying the rest", () => {
        const depositorOneRepayment = to1e18(4) // 5 - 1 = 4
        const depositorTwoRepayment = to1e18(5) // 10 - 5 = 5

        let txDepositorOne: ContractTransactionResponse
        let txDepositorTwo: ContractTransactionResponse

        // After another 60 days, both depositors repays fully.
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days
          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), depositorOneRepayment)
          txDepositorOne = await portal
            .connect(depositorOne)
            .repayReceipt(
              tbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await stBTC
            .connect(depositorTwo)
            .approve(await portal.getAddress(), depositorTwoRepayment)
          txDepositorTwo = await portal
            .connect(depositorTwo)
            .repayReceipt(
              tbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })

        it("should correctly calculate the fee owed", async () => {
          // 30 + 60 days, 5% fee, and 4 stBTC minted:
          // (4 * 0.05) * (90 / 365) = ~0.0493150
          // (*) The additional 30 days comes from the extra delay for the second
          //     depositor repayment in the previous test.
          //
          // 60 days, 5% fee, and 5 stBTC minted:
          // (5 * 0.05) * (60 / 365) = ~0.0410958
          //
          // 0.0410958 + 0.0493150 = 0.0904108
          // 0.1232876 + 0.0410958 = 0.1643834
          await assertFeeOwed(90410800000000000n, 164383400000000000n)
        })

        it("should transfer receipt tokens away and burn them", async () => {
          await expect(txDepositorOne).to.changeTokenBalance(
            stBTC,
            depositorOne.address,
            -depositorOneRepayment,
          )
          await expect(txDepositorOne)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo).to.changeTokenBalance(
            stBTC,
            depositorTwo.address,
            -depositorTwoRepayment,
          )
          await expect(txDepositorTwo)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorTwoRepayment,
            )
        })

        it("should zero receipt minted", async () => {
          const depositOne = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositorOneDepositId,
          )

          const depositTwo = await portal.getDeposit(
            depositorTwo.address,
            tbtcAddress,
            depositorTwoDepositId,
          )

          expect(depositOne.receiptMinted).to.equal(0)
          expect(depositTwo.receiptMinted).to.equal(0)
        })

        it("should zero total minted", async () => {
          const info = await portal.feeInfo(tbtcAddress)
          expect(info.totalMinted).to.equal(0)
        })

        it("should emit DepositRepaid event", async () => {
          await expect(txDepositorOne)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorTwo.address,
              tbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })
      })
    })

    context("when called correctly with mismatching decimals", () => {
      const depositAmount = to1ePrecision(10, 8)

      const depositorOneMintAmount = to1e18(5)
      const depositorTwoMintAmount = to1e18(10)

      const depositorOneDepositId = 1
      const depositorTwoDepositId = 2

      // We assert with 0.000001 precision. Asserting specific amounts is
      // possible but complicated given the block mining times and the order
      // of transactions. This would make the test very fragile and hard to
      // follow.
      const precision = 1000000000000 // 0.000001 in 1e18 precision

      // Helper function to assert feeOwed value for both depositors.
      // Let's use not repeat the same code over and over again.
      const assertFeeOwed = async (
        expectedDepositorOneFee: bigint,
        expectedDepositorTwoFee: bigint,
      ) => {
        const depositOne = await portal.getDeposit(
          depositorOne.address,
          wbtcAddress,
          depositorOneDepositId,
        )

        const depositTwo = await portal.getDeposit(
          depositorTwo.address,
          wbtcAddress,
          depositorTwoDepositId,
        )

        expect(depositOne.feeOwed).to.be.closeTo(
          expectedDepositorOneFee,
          precision,
        )
        expect(depositTwo.feeOwed).to.be.closeTo(
          expectedDepositorTwoFee,
          precision,
        )
      }

      before(async () => {
        await createSnapshot()

        // The first and the second depositor deposit 10 WBTC each.
        await WBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await WBTC.connect(depositorTwo).approve(
          await portal.getAddress(),
          depositAmount,
        )
        await portal
          .connect(depositorOne)
          .deposit(wbtcAddress, depositAmount, noLockPeriod)
        await portal
          .connect(depositorTwo)
          .deposit(wbtcAddress, depositAmount, noLockPeriod)

        // The fee for minting stBTC is 5%
        await portal
          .connect(deployer)
          .setReceiptParams(wbtcAddress, 5, 100, stbtcAddress)

        // The first depositors mints 5 stBTC, the second depositor mints 10 stBTC
        await portal
          .connect(depositorOne)
          .mintReceipt(
            wbtcAddress,
            depositorOneDepositId,
            depositorOneMintAmount,
          )
        await portal
          .connect(depositorTwo)
          .mintReceipt(
            wbtcAddress,
            depositorTwoDepositId,
            depositorTwoMintAmount,
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when repaying partially", () => {
        const depositorOneRepayment = to1e18(1)
        const depositorTwoRepayment = to1e18(5)

        let txDepositorOne: ContractTransactionResponse
        let txDepositorTwo: ContractTransactionResponse

        // After 60 days, the first depositor repays partially with 1stBTC.
        // After another 30 days, the second depositor repays partially with
        // 5 stBTC.
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days
          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), depositorOneRepayment)
          txDepositorOne = await portal
            .connect(depositorOne)
            .repayReceipt(
              wbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await helpers.time.increaseTime(30 * 86400) // 30 days
          await stBTC
            .connect(depositorTwo)
            .approve(await portal.getAddress(), depositorTwoRepayment)
          txDepositorTwo = await portal
            .connect(depositorTwo)
            .repayReceipt(
              wbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })

        it("should correctly calculate the fee owed", async () => {
          // 60 days, 5% fee, and 5 stBTC minted:
          // (5 * 0.05) * (60 / 365) = ~0.0410958
          //
          // 90 days, 5% fee, and 10 stBTC minted:
          // (10 * 0.05) * (90 / 365) = ~0.1232876
          await assertFeeOwed(41095800000000000n, 123287600000000000n)
        })

        it("should transfer receipt tokens away and burn them", async () => {
          await expect(txDepositorOne).to.changeTokenBalance(
            stBTC,
            depositorOne.address,
            -depositorOneRepayment,
          )
          await expect(txDepositorOne)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo).to.changeTokenBalance(
            stBTC,
            depositorTwo.address,
            -depositorTwoRepayment,
          )
          await expect(txDepositorTwo)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorTwoRepayment,
            )
        })

        it("should update receipt minted for deposit", async () => {
          const depositOneAfter = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositorOneDepositId,
          )

          expect(depositOneAfter.receiptMinted).to.equal(
            depositorOneMintAmount - depositorOneRepayment,
          )

          const depositTwoAfter = await portal.getDeposit(
            depositorTwo.address,
            wbtcAddress,
            depositorTwoDepositId,
          )

          expect(depositTwoAfter.receiptMinted).to.equal(
            depositorTwoMintAmount - depositorTwoRepayment,
          )
        })

        it("should update total minted", async () => {
          const feeInfo = await portal.feeInfo(wbtcAddress)
          expect(feeInfo.totalMinted).to.equal(
            depositorOneMintAmount +
              depositorTwoMintAmount -
              depositorOneRepayment -
              depositorTwoRepayment,
          )
        })

        it("should emit DepositRepaid event", async () => {
          await expect(txDepositorOne)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorTwo.address,
              wbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })
      })

      context("when repaying the rest", () => {
        const depositorOneRepayment = to1e18(4) // 5 - 1 = 4
        const depositorTwoRepayment = to1e18(5) // 10 - 5 = 5

        let txDepositorOne: ContractTransactionResponse
        let txDepositorTwo: ContractTransactionResponse

        // After another 60 days, both depositors repays fully.
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days
          await stBTC
            .connect(depositorOne)
            .approve(await portal.getAddress(), depositorOneRepayment)
          txDepositorOne = await portal
            .connect(depositorOne)
            .repayReceipt(
              wbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await stBTC
            .connect(depositorTwo)
            .approve(await portal.getAddress(), depositorTwoRepayment)
          txDepositorTwo = await portal
            .connect(depositorTwo)
            .repayReceipt(
              wbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })

        it("should correctly calculate the fee owed", async () => {
          // 30 + 60 days, 5% fee, and 4 stBTC minted:
          // (4 * 0.05) * (90 / 365) = ~0.0493150
          // (*) The additional 30 days comes from the extra delay for the second
          //     depositor repayment in the previous test.
          //
          // 60 days, 5% fee, and 5 stBTC minted:
          // (5 * 0.05) * (60 / 365) = ~0.0410958
          //
          // 0.0410958 + 0.0493150 = 0.0904108
          // 0.1232876 + 0.0410958 = 0.1643834
          await assertFeeOwed(90410800000000000n, 164383400000000000n)
        })

        it("should transfer receipt tokens away and burn them", async () => {
          await expect(txDepositorOne).to.changeTokenBalance(
            stBTC,
            depositorOne.address,
            -depositorOneRepayment,
          )
          await expect(txDepositorOne)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo).to.changeTokenBalance(
            stBTC,
            depositorTwo.address,
            -depositorTwoRepayment,
          )
          await expect(txDepositorTwo)
            .to.emit(stBTC, "Transfer")
            .withArgs(
              await portal.getAddress(),
              ZeroAddress,
              depositorTwoRepayment,
            )
        })

        it("should zero receipt minted", async () => {
          const depositOne = await portal.getDeposit(
            depositorOne.address,
            wbtcAddress,
            depositorOneDepositId,
          )

          const depositTwo = await portal.getDeposit(
            depositorTwo.address,
            wbtcAddress,
            depositorTwoDepositId,
          )

          expect(depositOne.receiptMinted).to.equal(0)
          expect(depositTwo.receiptMinted).to.equal(0)
        })

        it("should zero total minted", async () => {
          const info = await portal.feeInfo(wbtcAddress)
          expect(info.totalMinted).to.equal(0)
        })

        it("should emit DepositRepaid event", async () => {
          await expect(txDepositorOne)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorOne.address,
              wbtcAddress,
              depositorOneDepositId,
              depositorOneRepayment,
            )

          await expect(txDepositorTwo)
            .to.emit(portal, "ReceiptRepaid")
            .withArgs(
              depositorTwo.address,
              wbtcAddress,
              depositorTwoDepositId,
              depositorTwoRepayment,
            )
        })
      })
    })
  })
})
