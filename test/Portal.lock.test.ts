import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - lock method", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let tbtcAddress: string
  let usdcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const noLockPeriod = 0
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks
  const maxLockPeriod = 60 * 60 * 24 * 7 * 39 // 39 weeks = ~9 months

  before(async () => {
    ;({ TBTC, USDC, tbtcAddress, usdcAddress, portal, deployer, depositorOne } =
      await loadFixture(deployPortal))
  })

  describe("lock", () => {
    context("when called incorrectly", () => {
      context("when the deposit doesn't exist", () => {
        const depositId = 1
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .lock(tbtcAddress, depositId, weekPeriod * 3),
          ).to.be.revertedWithCustomError(portal, "DepositNotFound")
        })
      })

      context("when token can't be locked", () => {
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
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          const depositId = 1
          await expect(
            portal
              .connect(depositorOne)
              .lock(usdcAddress, depositId, weekPeriod * 3),
          )
            .to.be.revertedWithCustomError(portal, "InsufficientTokenAbility")
            .withArgs(usdcAddress, TokenAbility.Deposit)
        })
      })

      context("when lock period is less than 1 week", () => {
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
          const depositId = 1
          await expect(
            portal
              .connect(depositorOne)
              .lock(tbtcAddress, depositId, weekPeriod - 1),
          )
            .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
            .withArgs(weekPeriod - 1)
        })
      })

      context("when lock period is less than min lock period", () => {
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
          const depositId = 1
          await expect(
            portal
              .connect(depositorOne)
              .lock(tbtcAddress, depositId, minLockPeriod - 1),
          )
            .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
            .withArgs(minLockPeriod - 1)
        })
      })

      context("when lock period is more than max lock period", () => {
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
          const depositId = 1
          await expect(
            portal
              .connect(depositorOne)
              .lock(tbtcAddress, depositId, maxLockPeriod + weekPeriod),
          )
            .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
            .withArgs(maxLockPeriod + weekPeriod)
        })
      })

      context("when lock period is less than current lock period", () => {
        before(async () => {
          await createSnapshot()
          await TBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, minLockPeriod + weekPeriod)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          const depositId = 1
          await expect(
            portal
              .connect(depositorOne)
              .lock(tbtcAddress, depositId, minLockPeriod + weekPeriod - 60),
          ).to.be.revertedWithCustomError(portal, "LockPeriodTooShort")
        })
      })
    })

    context("when called correctly", () => {
      context("when locking deposit for the first time", () => {
        const depositId = 1

        let tx: ContractTransactionResponse
        let expectedUnlockTime: number

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
            .lock(tbtcAddress, depositId, minLockPeriod)

          expectedUnlockTime =
            (await helpers.time.lastBlockTime()) + minLockPeriod
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit a Locked event", async () => {
          await expect(tx)
            .to.emit(portal, "Locked")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              expectedUnlockTime,
              minLockPeriod,
            )
        })

        it("should set unlock time correctly", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).unlockAt,
          ).to.equal(expectedUnlockTime)
        })
      })

      context("when extending lock period", () => {
        const depositId = 1

        let tx: ContractTransactionResponse
        let expectedUnlockTime: number

        before(async () => {
          await createSnapshot()
          await TBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, minLockPeriod)

          tx = await portal
            .connect(depositorOne)
            .lock(tbtcAddress, depositId, minLockPeriod + weekPeriod)

          expectedUnlockTime =
            (await helpers.time.lastBlockTime()) + minLockPeriod + weekPeriod
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit a Locked event", async () => {
          await expect(tx)
            .to.emit(portal, "Locked")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              expectedUnlockTime,
              minLockPeriod + weekPeriod,
            )
        })

        it("should set unlock time correctly", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).unlockAt,
          ).to.equal(expectedUnlockTime)
        })
      })

      context("when locking deposit after lock period has expired", () => {
        const depositId = 1

        let tx: ContractTransactionResponse
        let expectedUnlockTime: number

        before(async () => {
          await createSnapshot()
          await TBTC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(tbtcAddress, depositAmount, minLockPeriod)

          await helpers.time.increaseTime(minLockPeriod + 1)

          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).unlockAt,
          ).to.be.lt(
            await helpers.time.lastBlockTime(),
            "Unlock time not expired yet",
          )

          tx = await portal
            .connect(depositorOne)
            .lock(tbtcAddress, depositId, minLockPeriod)

          expectedUnlockTime =
            (await helpers.time.lastBlockTime()) + minLockPeriod
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit a Locked event", async () => {
          await expect(tx)
            .to.emit(portal, "Locked")
            .withArgs(
              depositorOne.address,
              tbtcAddress,
              depositId,
              expectedUnlockTime,
              minLockPeriod,
            )
        })

        it("should set unlock time correctly", async () => {
          expect(
            (
              await portal.getDeposit(
                depositorOne.address,
                tbtcAddress,
                depositId,
              )
            ).unlockAt,
          ).to.equal(expectedUnlockTime)
        })
      })
    })
  })
})
