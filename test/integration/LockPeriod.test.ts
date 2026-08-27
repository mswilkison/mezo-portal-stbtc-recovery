import chaiAsPromised from "chai-as-promised"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { use, expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../../typechain"
import deployPortal from "../fixtures/deployPortal"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

use(chaiAsPromised)

describe("Integration tests - Lock Period", () => {
  let TBTC: MockERC20
  let tbtcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks
  const maxLockPeriod = 60 * 60 * 24 * 7 * 39 // 39 weeks = ~9 months

  before(async () => {
    ;({ TBTC, tbtcAddress, portal, deployer, depositorOne } =
      await loadFixture(deployPortal))
  })

  context("when updating allowed lock period range", () => {
    context("when minimum lock period is increased", () => {
      const increasedMinLockPeriod = minLockPeriod * 2

      before(async () => {
        await createSnapshot()
        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount * 2n,
        )

        // Make a deposit with the current minimum lock period
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, minLockPeriod)

        // Increase the minimum lock period
        await portal.connect(deployer).setMinLockPeriod(increasedMinLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow to use new minimum lock period for new deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, increasedMinLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + increasedMinLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          2,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should allow to extend the lock of the existing deposits", async () => {
        // Try to use the old minimum lock period
        await expect(
          portal.connect(depositorOne).lock(tbtcAddress, 1, minLockPeriod + 1),
        )
          .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
          .withArgs(minLockPeriod + 1)

        // Use the new minimum lock period
        await expect(
          portal
            .connect(depositorOne)
            .lock(tbtcAddress, 1, increasedMinLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + increasedMinLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          1,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })
    })

    context("when minimum lock period is decreased", () => {
      const decreasedMinLockPeriod = minLockPeriod / 2

      before(async () => {
        await createSnapshot()
        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount * 2n,
        )

        // Make a deposit with the current minimum lock period
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, minLockPeriod)

        // Decrease the minimum lock period
        await portal.connect(deployer).setMinLockPeriod(decreasedMinLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow to use new minimum lock period for new deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, decreasedMinLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + decreasedMinLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          2,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should not allow to decrease the lock period of the existing deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(tbtcAddress, 1, decreasedMinLockPeriod),
        ).to.be.revertedWithCustomError(portal, "LockPeriodTooShort")
      })
    })

    context("when maximum lock period is increased", () => {
      const increasedMaxLockPeriod = maxLockPeriod * 2

      before(async () => {
        await createSnapshot()
        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount * 2n,
        )

        // Make a deposit with the current maximum lock period
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, maxLockPeriod)

        // Increase the maximum lock period
        await portal.connect(deployer).setMaxLockPeriod(increasedMaxLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow to use new maximum lock period for new deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, increasedMaxLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + increasedMaxLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          2,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should allow to extend the lock of the existing deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(tbtcAddress, 1, increasedMaxLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + increasedMaxLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          1,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })
    })

    context("when maximum lock period is decreased", () => {
      const decreasedMaxLockPeriod = maxLockPeriod - 60 * 60 * 24 * 14 // -2 weeks

      before(async () => {
        await createSnapshot()
        await TBTC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount * 2n,
        )

        // Make a deposit with the current maximum lock period
        await portal
          .connect(depositorOne)
          .deposit(tbtcAddress, depositAmount, maxLockPeriod)

        // Decrease the maximum lock period
        await portal.connect(deployer).setMaxLockPeriod(decreasedMaxLockPeriod)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should allow to use new maximum lock period for new deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, decreasedMaxLockPeriod),
        ).to.not.be.reverted

        const expectedUnlockTime =
          (await helpers.time.lastBlockTime()) + decreasedMaxLockPeriod

        const { unlockAt } = await portal.getDeposit(
          depositorOne.address,
          tbtcAddress,
          2,
        )

        expect(unlockAt).to.be.equal(expectedUnlockTime)
      })

      it("should not allow to decrease the lock period of the existing deposits", async () => {
        await expect(
          portal
            .connect(depositorOne)
            .lock(tbtcAddress, 1, decreasedMaxLockPeriod),
        ).to.be.revertedWithCustomError(portal, "LockPeriodTooShort")
      })
    })
  })
})
