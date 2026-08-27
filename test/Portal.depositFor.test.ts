import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse, ZeroAddress } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - depositFor method", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let tbtcAddress: string
  let usdcAddress: string
  let otherAddress: string
  let portal: Portal
  let thirdParty: HardhatEthersSigner
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const noLockPeriod = 0
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks
  const maxLockPeriod = 60 * 60 * 24 * 7 * 39 // 39 weeks = ~9 months
  const threeDaysPeriod = 60 * 60 * 24 * 3 // 3 days

  before(async () => {
    ;({
      TBTC,
      USDC,
      tbtcAddress,
      usdcAddress,
      otherAddress,
      portal,
      thirdParty,
      deployer,
      depositorOne,
    } = await loadFixture(deployPortal))
  })

  describe("depositFor", () => {
    context("when called incorrectly", () => {
      context("when depositing without locking", () => {
        beforeEach(async () => {
          await createSnapshot()
        })

        afterEach(async () => {
          await restoreSnapshot()
        })

        context("when depositing 0-address token", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  ZeroAddress,
                  ethers.parseEther("1"),
                  noLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "TokenNotSupported")
              .withArgs(ZeroAddress)
          })
        })

        context("when depositing unsupported token", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  otherAddress,
                  ethers.parseEther("1"),
                  noLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "TokenNotSupported")
              .withArgs(otherAddress)
          })
        })

        context("when depositing with 0-address deposit owner", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  ZeroAddress,
                  tbtcAddress,
                  ethers.parseEther("1"),
                  noLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectDepositor")
              .withArgs(ZeroAddress)
          })
        })

        context("when depositing 0 amount", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  tbtcAddress,
                  ethers.parseEther("0"),
                  noLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectAmount")
              .withArgs(0)
          })
        })
      })

      context("when depositing with locking", () => {
        beforeEach(async () => {
          await createSnapshot()
          await portal.connect(deployer).addSupportedToken({
            token: usdcAddress,
            tokenAbility: TokenAbility.Deposit,
          })
          await USDC.connect(thirdParty).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await TBTC.connect(thirdParty).approve(
            await portal.getAddress(),
            depositAmount,
          )
        })

        afterEach(async () => {
          await restoreSnapshot()
        })

        context("when token is not supported", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  otherAddress,
                  depositAmount,
                  minLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "TokenNotSupported")
              .withArgs(otherAddress)
          })
        })

        context("when token is not lockable", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  usdcAddress,
                  depositAmount,
                  minLockPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "InsufficientTokenAbility")
              .withArgs(usdcAddress, TokenAbility.Deposit)
          })
        })

        context("when lock time is less than 1 week", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  tbtcAddress,
                  depositAmount,
                  threeDaysPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
              .withArgs(threeDaysPeriod)
          })
        })

        context("when lock time is less than min lock time", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  tbtcAddress,
                  depositAmount,
                  minLockPeriod - 1,
                ),
            )
              .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
              .withArgs(minLockPeriod - 1)
          })
        })

        context("when lock time is greater than max lock time", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(thirdParty)
                .depositFor(
                  depositorOne.address,
                  tbtcAddress,
                  depositAmount,
                  maxLockPeriod + weekPeriod,
                ),
            )
              .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
              .withArgs(maxLockPeriod + weekPeriod)
          })
        })

        context("when lock time is not a multiple of a week", () => {
          it("should round the lock period to the nearest week", async () => {
            const depositId = 1

            await portal
              .connect(thirdParty)
              .depositFor(
                depositorOne.address,
                tbtcAddress,
                depositAmount,
                minLockPeriod + threeDaysPeriod,
              )

            expect(
              (
                await portal.getDeposit(
                  depositorOne.address,
                  tbtcAddress,
                  depositId,
                )
              ).unlockAt,
            ).to.equal((await helpers.time.lastBlockTime()) + minLockPeriod)
          })
        })
      })
    })

    context("when called correctly", () => {
      context("when depositing without locking", () => {
        context("when depositing for someone else", () => {
          const depositId = 1

          let tx: ContractTransactionResponse
          let depositorBalanceBefore: bigint

          let expectedUnlockTime: number

          before(async () => {
            await createSnapshot()

            depositorBalanceBefore = await TBTC.balanceOf(thirdParty.address)

            await TBTC.connect(thirdParty).approve(
              await portal.getAddress(),
              depositAmount,
            )

            tx = await portal
              .connect(thirdParty)
              .depositFor(
                depositorOne.address,
                tbtcAddress,
                depositAmount,
                noLockPeriod,
              )

            expectedUnlockTime = await helpers.time.lastBlockTime()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit a Deposited event", async () => {
            await expect(tx)
              .to.emit(portal, "Deposited")
              .withArgs(
                depositorOne.address,
                tbtcAddress,
                depositId,
                depositAmount,
              )
          })

          it("should update the balance of the depositor", async () => {
            expect(
              (
                await portal.getDeposit(
                  depositorOne.address,
                  tbtcAddress,
                  depositId,
                )
              ).balance,
            ).to.equal(depositAmount)
          })

          it("should set unlock time to current block", async () => {
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

          it("should transfer the token to the contract", async () => {
            expect(await TBTC.balanceOf(await portal.getAddress())).to.equal(
              depositAmount,
            )
            expect(await TBTC.balanceOf(thirdParty.address)).to.equal(
              depositorBalanceBefore - depositAmount,
            )
          })
        })

        context("when depositing for oneself", () => {
          const depositId = 1

          let tx: ContractTransactionResponse
          let depositorBalanceBefore: bigint

          let expectedUnlockTime: number

          before(async () => {
            await createSnapshot()

            depositorBalanceBefore = await TBTC.balanceOf(depositorOne.address)

            await TBTC.connect(depositorOne).approve(
              await portal.getAddress(),
              depositAmount,
            )

            tx = await portal
              .connect(depositorOne)
              .depositFor(
                depositorOne.address,
                tbtcAddress,
                depositAmount,
                noLockPeriod,
              )

            expectedUnlockTime = await helpers.time.lastBlockTime()
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit a Deposited event", async () => {
            await expect(tx)
              .to.emit(portal, "Deposited")
              .withArgs(
                depositorOne.address,
                tbtcAddress,
                depositId,
                depositAmount,
              )
          })

          it("should update the balance of the depositor", async () => {
            expect(
              (
                await portal.getDeposit(
                  depositorOne.address,
                  tbtcAddress,
                  depositId,
                )
              ).balance,
            ).to.equal(depositAmount)
          })

          it("should set unlock time to current block", async () => {
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

          it("should transfer the token to the contract", async () => {
            expect(await TBTC.balanceOf(await portal.getAddress())).to.equal(
              depositAmount,
            )
            expect(await TBTC.balanceOf(depositorOne.address)).to.equal(
              depositorBalanceBefore - depositAmount,
            )
          })
        })
      })

      context("when depositing with locking", () => {
        context("when depositing with locking for someone else", () => {
          const depositId = 1

          let tx: ContractTransactionResponse
          let expectedUnlockTime: number

          before(async () => {
            await createSnapshot()

            await TBTC.connect(thirdParty).approve(
              await portal.getAddress(),
              depositAmount,
            )

            tx = await portal
              .connect(thirdParty)
              .depositFor(
                depositorOne.address,
                tbtcAddress,
                depositAmount,
                minLockPeriod,
              )

            expectedUnlockTime =
              (await helpers.time.lastBlockTime()) + minLockPeriod
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit a Deposited event", async () => {
            await expect(tx)
              .to.emit(portal, "Deposited")
              .withArgs(
                depositorOne.address,
                tbtcAddress,
                depositId,
                depositAmount,
              )
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
            const { unlockAt } = await portal.getDeposit(
              depositorOne.address,
              tbtcAddress,
              depositId,
            )

            expect(unlockAt).to.equal(expectedUnlockTime)
          })
        })

        context("when depositing with locking for oneself", () => {
          const depositId = 1

          let tx: ContractTransactionResponse
          let expectedUnlockTime: number

          before(async () => {
            await createSnapshot()

            await TBTC.connect(depositorOne).approve(
              await portal.getAddress(),
              depositAmount,
            )

            tx = await portal
              .connect(depositorOne)
              .depositFor(
                depositorOne.address,
                tbtcAddress,
                depositAmount,
                minLockPeriod,
              )

            expectedUnlockTime =
              (await helpers.time.lastBlockTime()) + minLockPeriod
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit a Deposited event", async () => {
            await expect(tx)
              .to.emit(portal, "Deposited")
              .withArgs(
                depositorOne.address,
                tbtcAddress,
                depositId,
                depositAmount,
              )
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
            const { unlockAt } = await portal.getDeposit(
              depositorOne.address,
              tbtcAddress,
              depositId,
            )

            expect(unlockAt).to.equal(expectedUnlockTime)
          })
        })
      })
    })
  })
})
