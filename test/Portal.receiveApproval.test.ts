import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - receiveApproval method", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let tbtcAddress: string
  let usdcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks
  const maxLockPeriod = 60 * 60 * 24 * 7 * 39 // 39 weeks = ~9 months

  before(async () => {
    ;({ TBTC, USDC, tbtcAddress, usdcAddress, portal, deployer, depositorOne } =
      await loadFixture(deployPortal))
  })

  describe("receiveApproval", () => {
    const shouldNotLockEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32"],
      [0],
    )

    const shouldLockEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint32"],
      [minLockPeriod],
    )

    context("when called incorrectly", () => {
      context("when depositing without locking", () => {
        beforeEach(async () => {
          await createSnapshot()
        })

        afterEach(async () => {
          await restoreSnapshot()
        })

        context("when receiving unsupported token", () => {
          it("should revert", async () => {
            await expect(
              USDC.connect(depositorOne).approveAndCall(
                await portal.getAddress(),
                depositAmount,
                shouldNotLockEncoded,
              ),
            )
              .to.be.revertedWithCustomError(portal, "TokenNotSupported")
              .withArgs(usdcAddress)
          })
        })

        context("when called directly", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(depositorOne)
                .receiveApproval(
                  depositorOne,
                  depositAmount,
                  tbtcAddress,
                  shouldNotLockEncoded,
                ),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
              .withArgs(tbtcAddress)
          })
        })

        context("when receiving empty lock period data", () => {
          it("should revert", async () => {
            const emptyData = ethers.AbiCoder.defaultAbiCoder().encode([], [])

            await expect(
              TBTC.connect(depositorOne).approveAndCall(
                await portal.getAddress(),
                depositAmount,
                emptyData,
              ),
            ).to.be.revertedWithoutReason()
          })
        })

        context("when depositing amount exceeding uint96", () => {
          it("should revert", async () => {
            await expect(
              TBTC.connect(depositorOne).approveAndCall(
                await portal.getAddress(),
                2n ** 96n,
                shouldNotLockEncoded,
              ),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectAmount")
              .withArgs(2n ** 96n)
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
        })

        afterEach(async () => {
          await restoreSnapshot()
        })

        context("when it's trying to lock not lockable token", () => {
          it("should revert", async () => {
            await expect(
              USDC.connect(depositorOne).approveAndCall(
                await portal.getAddress(),
                depositAmount,
                shouldLockEncoded,
              ),
            )
              .to.be.revertedWithCustomError(portal, "InsufficientTokenAbility")
              .withArgs(usdcAddress, TokenAbility.Deposit)
          })
        })

        context("when it's trying to lock without lock period", () => {
          it("should revert", async () => {
            const emptyData = ethers.AbiCoder.defaultAbiCoder().encode([], [])

            await expect(
              TBTC.connect(depositorOne).approveAndCall(
                await portal.getAddress(),
                depositAmount,
                emptyData,
              ),
            ).to.be.revertedWithoutReason()
          })
        })

        context(
          "when it's trying to lock with lock period less than min lock period",
          () => {
            it("should revert", async () => {
              const encodedLockPeriod =
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ["uint256"],
                  [minLockPeriod - 1],
                )

              await expect(
                TBTC.connect(depositorOne).approveAndCall(
                  await portal.getAddress(),
                  depositAmount,
                  encodedLockPeriod,
                ),
              )
                .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
                .withArgs(minLockPeriod - 1)
            })
          },
        )

        context(
          "when it's trying to lock with lock period exceeding max lock period",
          async () => {
            it("should revert", async () => {
              const encodedLockPeriod =
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ["uint256"],
                  [maxLockPeriod + weekPeriod],
                )

              await expect(
                TBTC.connect(depositorOne).approveAndCall(
                  await portal.getAddress(),
                  depositAmount,
                  encodedLockPeriod,
                ),
              )
                .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
                .withArgs(maxLockPeriod + weekPeriod)
            })
          },
        )

        context(
          "when it's trying to lock with lock period of 1 day",
          async () => {
            it("should revert", async () => {
              const encodedLockPeriod =
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ["uint256"],
                  [60 * 60 * 24],
                )

              await expect(
                TBTC.connect(depositorOne).approveAndCall(
                  await portal.getAddress(),
                  depositAmount,
                  encodedLockPeriod,
                ),
              )
                .to.be.revertedWithCustomError(portal, "LockPeriodOutOfRange")
                .withArgs(60 * 60 * 24)
            })
          },
        )
      })
    })

    context("when called correctly", () => {
      context("when depositing without locking", () => {
        const depositId = 1

        let tx: ContractTransactionResponse
        let balanceBefore: bigint

        before(async () => {
          await createSnapshot()
          balanceBefore = await TBTC.balanceOf(depositorOne.address)
          tx = await TBTC.connect(depositorOne).approveAndCall(
            await portal.getAddress(),
            depositAmount,
            shouldNotLockEncoded,
          )
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
          const { balance } = await portal.getDeposit(
            depositorOne.address,
            tbtcAddress,
            depositId,
          )

          expect(balance).to.equal(depositAmount)
        })

        it("should transfer the token to the contract", async () => {
          expect(await TBTC.balanceOf(await portal.getAddress())).to.equal(
            depositAmount,
          )
          expect(await TBTC.balanceOf(depositorOne.address)).to.equal(
            balanceBefore - depositAmount,
          )
        })
      })

      context("when depositing with locking", () => {
        const depositId = 1

        let tx: ContractTransactionResponse
        let expectedUnlockTime: number

        before(async () => {
          await createSnapshot()

          tx = await TBTC.connect(depositorOne).approveAndCall(
            await portal.getAddress(),
            depositAmount,
            shouldLockEncoded,
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
