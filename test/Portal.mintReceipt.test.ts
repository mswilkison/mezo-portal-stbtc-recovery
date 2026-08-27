import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { to1e18 } from "@keep-network/hardhat-helpers/dist/number"
import { MockERC20, MockSTBTC, MockWBTC, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - mintReceipt method", () => {
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
  })

  describe("mintReceipt", () => {
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

      context("when receipt token is not set", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .mintReceipt(tbtcAddress, depositId, depositAmount),
          ).to.be.revertedWithCustomError(portal, "ReceiptMintingDisabled")
        })
      })

      context("when amount is zero", () => {
        const mintCap = 90 // 90%
        const annualFee = 0 // 0%

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal.connect(depositorOne).mintReceipt(tbtcAddress, depositId, 0),
          ).to.be.revertedWithCustomError(portal, "IncorrectAmount")
        })
      })

      context("when deposit is not found", () => {
        const mintCap = 90 // 90%
        const annualFee = 0 // 0%

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal.connect(depositorOne).mintReceipt(
              tbtcAddress,
              1337, // no deposit with this ID
              depositAmount,
            ),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when mint cap is not set", () => {
        const mintCap = 0 // 0%
        const annualFee = 0 // 0%

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal.connect(depositorOne).mintReceipt(tbtcAddress, depositId, 1),
          )
            .to.be.revertedWithCustomError(portal, "ReceiptMintLimitExceeded")
            .withArgs(0, 0, 0, 1)
        })
      })

      context("when mint cap is exceeded for the first mint", () => {
        const mintCap = 50 // 50%
        const annualFee = 0 // 0%
        const mintLimit = depositAmount / 2n

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .mintReceipt(tbtcAddress, depositId, mintLimit + 1n),
          )
            .to.be.revertedWithCustomError(portal, "ReceiptMintLimitExceeded")
            .withArgs(mintLimit, 0, 0, mintLimit + 1n)
        })
      })

      context("when mint cap is exceeded for the next mint", () => {
        const mintCap = 50 // 50%
        const annualFee = 0 // 0%
        const mintLimit = depositAmount / 2n

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)

          // This should work, we are not exceeding the mint cap
          await expect(
            portal
              .connect(depositorOne)
              .mintReceipt(tbtcAddress, depositId, mintLimit),
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // We are at the cap, minting more is not possible
          await expect(
            portal.connect(depositorOne).mintReceipt(tbtcAddress, depositId, 1),
          )
            .to.be.revertedWithCustomError(portal, "ReceiptMintLimitExceeded")
            .withArgs(mintLimit, mintLimit, 0, 1)
        })
      })

      context("when mint cap is exceeded with the fee accrued", () => {
        const mintCap = 90 // 90%
        const annualFee = 10 // 10%
        const mintLimit = (depositAmount * 9n) / 10n // 90% of the deposit amount
        const receiptToMint = (depositAmount * 8n) / 10n // 80% of the deposit amount

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, annualFee, mintCap, stbtcAddress)

          await expect(
            portal
              .connect(depositorOne)
              .mintReceipt(tbtcAddress, depositId, receiptToMint),
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          // The deposit amount is 1 tBTC and the annual fee is 10%.
          // The user minted receipt tokens for 80% of the deposit, so 0.8 tBTC.
          // 0.8 * 10% * 30/365 tBTC fee accrues every month.
          //
          // The minting cap is 90% of the deposit, so 0.9 tBTC.
          //
          // After 16 months, the fee accrued is 0.8 * 10% * 30/365 * 16 and
          // together with the deposit amount it exceeds the minting cap:
          // 0.8 * 10% * 30/365 * 16 + 0.8 =
          // ~0.1052054 + 0.8 > 0.9

          // ~0.1052054; it is quite a fragile value if we change the order of
          // calls in the before() function
          const expectedFeeAccrued = 105205481976348158n

          await helpers.time.increaseTime(16 * 30 * 86400)

          await expect(
            portal.connect(depositorOne).mintReceipt(tbtcAddress, depositId, 1),
          )
            .to.be.revertedWithCustomError(portal, "ReceiptMintLimitExceeded")
            .withArgs(mintLimit, receiptToMint, expectedFeeAccrued, 1)
        })
      })
    })

    context("when called correctly", () => {
      const depositId = 1
      const depositAmount = to1e18(1)
      const mintLimit = 50 // 50%
      const mintAmount = depositAmount / 4n

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

        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 5, mintLimit, stbtcAddress)

        tx = await portal
          .connect(depositorOne)
          .mintReceipt(tbtcAddress, depositId, mintAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update total minted", async () => {
        const info = await portal.feeInfo(tbtcAddress)
        expect(info.totalMinted).to.equal(mintAmount)
      })

      it("should update receipt minted", async () => {
        const depositState = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          depositId,
        )

        expect(depositState.receiptMinted).to.equal(mintAmount)
      })

      it("should mint the correct amount of stBTC", async () => {
        await expect(tx).to.changeTokenBalances(
          stBTC,
          [depositorOne],
          [mintAmount],
        )
      })

      it("should emit ReceiptMinted event", async () => {
        await expect(tx)
          .to.emit(portal, "ReceiptMinted")
          .withArgs(depositorOne.address, tbtcAddress, depositId, mintAmount)
      })
    })

    context("when called correctly with mismatching token decimals", () => {
      const depositId = 1
      const depositAmount = 1n * 10n ** 8n
      const mintLimit = 50 // 50%

      // Amount of stBTC to be minted, as this is calculated based on the WBTC
      // deposit amount - it need to be adjusted to the stBTC decimals
      const mintAmount = (depositAmount * 10n ** 10n) / 4n

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

        await portal
          .connect(deployer)
          .setReceiptParams(wbtcAddress, 5, mintLimit, stbtcAddress)

        tx = await portal
          .connect(depositorOne)
          .mintReceipt(wbtcAddress, depositId, mintAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update total minted", async () => {
        const info = await portal.feeInfo(wbtcAddress)
        expect(info.totalMinted).to.equal(mintAmount)
      })

      it("should update receipt minted", async () => {
        const depositState = await portal.getDeposit(
          depositorOne.address,
          wbtcAddress,
          depositId,
        )

        expect(depositState.receiptMinted).to.equal(mintAmount)
      })

      it("should mint the correct amount of stBTC", async () => {
        await expect(tx).to.changeTokenBalances(
          stBTC,
          [depositorOne],
          [mintAmount],
        )
      })

      it("should emit ReceiptMinted event", async () => {
        await expect(tx)
          .to.emit(portal, "ReceiptMinted")
          .withArgs(depositorOne.address, wbtcAddress, depositId, mintAmount)
      })
    })

    context("when called multiple times with different parameters", () => {
      const depositAmount = to1e18(10)
      const depositorOneDepositId = 1
      const depositorTwoDepositId = 2

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

        // If the fee is expected to be zero, we assert it is zero, period.
        // If the fee is non-zero we assert with 0.000001 precision. Asserting
        // specific amounts is possible but complicated given the block mining
        // times and the order of transactions. This would make the test very
        // fragile and hard to follow.
        const precision = 1000000000000 // 0.000001 in 1e18 precision

        if (expectedDepositorOneFee === 0n) {
          expect(depositOne.feeOwed).to.equal(expectedDepositorOneFee)
        } else {
          expect(depositOne.feeOwed).to.be.closeTo(
            expectedDepositorOneFee,
            precision,
          )
        }

        if (expectedDepositorTwoFee === 0n) {
          expect(depositTwo.feeOwed).to.equal(expectedDepositorTwoFee)
        } else {
          expect(depositTwo.feeOwed).to.be.closeTo(
            expectedDepositorTwoFee,
            precision,
          )
        }
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

        // The fee for minting stBTC is 0% initially
        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 0, 100, stbtcAddress)
      })

      after(async () => {
        await restoreSnapshot()
      })

      //
      // The fee is 0%, both depositors mint 1stBTC receipt tokens.
      // 30 days passes and the fee is updated to 10%.
      // We should expect the depositors do not owe any fees for those first
      // 30 days.
      //
      context("for the first parameter update", () => {
        before(async () => {
          await portal
            .connect(depositorOne)
            .mintReceipt(tbtcAddress, depositorOneDepositId, to1e18(1))
          await portal
            .connect(depositorTwo)
            .mintReceipt(tbtcAddress, depositorTwoDepositId, to1e18(1))

          await helpers.time.increaseTime(30 * 86400)
          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 10, 100, stbtcAddress)
        })

        it("should correctly update the fee owed", async () => {
          await assertFeeOwed(0n, 0n)
        })
      })

      //
      // The fee is 10%, both depositors still have 1 stBTC minted each.
      // 30 days passes, and the fee is updated to 1%. The depositors mint
      // more receipt tokens: 1stBTC for depositor one and 4 stBTC for depositor
      // two. We should expect the depositors to owe appropriate fee based on
      // those 30 days with 10% fee and 1stBTC minted each.
      //
      context("for the second parameter update", () => {
        before(async () => {
          await helpers.time.increaseTime(30 * 86400) // 30 days

          // decrease the fee to 1%
          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 1, 100, stbtcAddress)

          await portal
            .connect(depositorOne)
            .mintReceipt(tbtcAddress, depositorOneDepositId, to1e18(2))
          await portal
            .connect(depositorTwo)
            .mintReceipt(tbtcAddress, depositorTwoDepositId, to1e18(4))
        })

        it("should correctly update the fee owed", async () => {
          // 30 days, fee 10% yearly
          // (1 * 0.1) * (30 / 365) = ~0.0082191
          await assertFeeOwed(8219100000000000n, 8219100000000000n)
        })
      })

      //
      // The fee is 1%, the first depositor has 3 stBTC minted and the second
      // depositor has 5 stBTC minted. 60 days passes. The depositors mint
      // another 1 stBTC each. We should expect the depositors to owe
      // appropriate fee based on those 60 days with 1% fee.
      //
      context("for the third parameter update", () => {
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days

          await portal
            .connect(depositorOne)
            .mintReceipt(tbtcAddress, depositorOneDepositId, to1e18(1))
          await portal
            .connect(depositorTwo)
            .mintReceipt(tbtcAddress, depositorTwoDepositId, to1e18(1))
        })

        it("should correctly update the fee owed", async () => {
          // 60 days, fee 1% yearly
          // (3 * 0.01) * (60 / 365) = ~0.0049315
          // (5 * 0.01) * (60 / 365) = ~0.0082191
          //
          // 0.0082191 + 0.0049315 = 0.0131506
          // 0.0082191 + 0.0082191 = 0.0164382
          await assertFeeOwed(13150600000000000n, 16438200000000000n)
        })
      })
    })
  })
})
