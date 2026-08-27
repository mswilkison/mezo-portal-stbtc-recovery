import chaiAsPromised from "chai-as-promised"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { use, expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../../typechain"
import deployPortal from "../fixtures/deployPortal"
import { TokenAbility } from "../../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

use(chaiAsPromised)

describe("Integration tests - Supported Tokens", () => {
  let USDC: MockERC20
  let usdcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks

  before(async () => {
    ;({ USDC, usdcAddress, portal, deployer, depositorOne } =
      await loadFixture(deployPortal))
  })

  context("when updating supported tokens", () => {
    context("when new token can only be deposited", () => {
      const depositId = 1
      before(async () => {
        await createSnapshot()
        await portal.connect(deployer).addSupportedToken({
          token: usdcAddress,
          tokenAbility: TokenAbility.Deposit,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should make a deposit of the new token", async () => {
        await USDC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )

        await expect(
          portal.connect(depositorOne).deposit(usdcAddress, depositAmount, 0),
        ).to.not.be.reverted

        expect(
          (
            await portal.getDeposit(
              depositorOne.address,
              usdcAddress,
              depositId,
            )
          ).balance,
        ).to.be.equal(depositAmount)
      })

      it("should not lock the deposit of the new token", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(usdcAddress, depositId, minLockPeriod),
        )
          .to.be.revertedWithCustomError(portal, "InsufficientTokenAbility")
          .withArgs(usdcAddress, TokenAbility.Deposit)
      })

      it("should withdraw the deposit of the new token", async () => {
        await portal.connect(depositorOne).withdraw(usdcAddress, depositId)

        expect(
          (
            await portal.getDeposit(
              depositorOne.address,
              usdcAddress,
              depositId,
            )
          ).balance,
        ).to.be.equal(0n)
      })
    })

    context("when new token can be deposited and locked", () => {
      const firstDepositId = 1
      const secondDepositId = 2

      before(async () => {
        await createSnapshot()
        await portal.connect(deployer).addSupportedToken({
          token: usdcAddress,
          tokenAbility: TokenAbility.DepositAndLock,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should make a deposit of the new token", async () => {
        await USDC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )

        await expect(
          portal.connect(depositorOne).deposit(usdcAddress, depositAmount, 0),
        ).to.not.be.reverted

        const expectedUnlockTime = await helpers.time.lastBlockTime()

        const { balance, unlockAt } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          firstDepositId,
        )

        expect(balance).to.be.equal(depositAmount)
        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should allow to lock the deposit of the new token later", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(usdcAddress, firstDepositId, minLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + minLockPeriod

        const { balance, unlockAt } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          firstDepositId,
        )

        expect(balance).to.be.equal(depositAmount)
        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should make a deposit of the new token with a lock", async () => {
        await USDC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )

        await expect(
          portal
            .connect(depositorOne)
            .deposit(usdcAddress, depositAmount, minLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + minLockPeriod

        const { balance, unlockAt } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          secondDepositId,
        )

        expect(balance).to.be.equal(depositAmount)
        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should extend the lock the deposit of the new token", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(usdcAddress, secondDepositId, minLockPeriod * 2),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + minLockPeriod * 2

        const { balance, unlockAt } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          secondDepositId,
        )

        expect(balance).to.be.equal(depositAmount)
        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should withdraw the deposits of the new token after lock period", async () => {
        await helpers.time.increaseTime(minLockPeriod * 2)

        const userBalanceBefore = await USDC.balanceOf(depositorOne.address)

        await portal.connect(depositorOne).withdraw(usdcAddress, firstDepositId)
        await portal
          .connect(depositorOne)
          .withdraw(usdcAddress, secondDepositId)

        const { balance: firstDepositBalance } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          firstDepositId,
        )

        const { balance: secondDepositBalance } = await portal.getDeposit(
          depositorOne.address,
          usdcAddress,
          secondDepositId,
        )

        expect(firstDepositBalance).to.be.equal(0n)
        expect(secondDepositBalance).to.be.equal(0n)

        const userBalanceAfter = await USDC.balanceOf(depositorOne.address)

        expect(userBalanceAfter).to.be.equal(
          userBalanceBefore + depositAmount + depositAmount,
        )

        const contractBalance = await USDC.balanceOf(await portal.getAddress())

        expect(contractBalance).to.be.equal(0n)
      })
    })
  })
})
