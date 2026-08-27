import chaiAsPromised from "chai-as-promised"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { use, expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ContractTransactionResponse } from "ethers"
import { MockERC20, Portal } from "../../typechain"
import deployPortal from "../fixtures/deployPortal"
import { TokenAbility } from "../../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

use(chaiAsPromised)

describe("Integration tests - Liquidity Treasury", () => {
  let USDC: MockERC20
  let usdcAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let liquidityTreasuryMultisig: HardhatEthersSigner

  const noLockPeriod = 0
  const depositAmount = ethers.parseUnits("1", 6)
  const withdrawAmount = depositAmount / 2n

  before(async () => {
    ;({
      USDC,
      usdcAddress,
      portal,
      deployer,
      depositorOne,
      liquidityTreasuryMultisig,
    } = await loadFixture(deployPortal))
  })

  describe("user deposit and withdrawal with treasury intervention", () => {
    context(
      "when user tries to withdraw but fails due to low balance on the Portal",
      () => {
        const depositId = 1
        let tx: ContractTransactionResponse

        before(async () => {
          // Create snapshot
          await createSnapshot()

          // Add USDC as a supported token
          await portal.connect(deployer).addSupportedToken({
            token: usdcAddress,
            tokenAbility: TokenAbility.DepositAndLock,
          })

          // Set USDC as liquidity treasury managed
          await portal
            .connect(deployer)
            .setAssetAsLiquidityTreasuryManaged(usdcAddress, true)

          // Approve and deposit USDC by user
          await USDC.connect(depositorOne).approve(
            await portal.getAddress(),
            depositAmount,
          )
          await portal
            .connect(depositorOne)
            .deposit(usdcAddress, depositAmount, noLockPeriod)

          // Simulate low balance on Portal by withdrawing all funds to the liquidity treasury
          await portal
            .connect(liquidityTreasuryMultisig)
            .withdrawAsLiquidityTreasury(usdcAddress, depositAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert due to low balance", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .withdrawPartially(usdcAddress, depositId, withdrawAmount),
          )
            .to.be.revertedWithCustomError(USDC, "ERC20InsufficientBalance")
            .withArgs(await portal.getAddress(), 0, withdrawAmount)
        })

        context("when treasury returns funds to the Portal", () => {
          before(async () => {
            await USDC.connect(liquidityTreasuryMultisig).transfer(
              await portal.getAddress(),
              withdrawAmount,
            )
          })

          it("should have enough balance on the Portal after treasury deposit", async () => {
            const portalBalance = await USDC.balanceOf(
              await portal.getAddress(),
            )

            expect(portalBalance).to.be.at.least(withdrawAmount)
          })

          context("when user successfully withdraws their deposit", () => {
            it("should emit a Withdrawn event", async () => {
              tx = await portal
                .connect(depositorOne)
                .withdrawPartially(usdcAddress, depositId, withdrawAmount)

              await expect(tx)
                .to.emit(portal, "Withdrawn")
                .withArgs(
                  depositorOne.address,
                  usdcAddress,
                  depositId,
                  withdrawAmount,
                )
            })

            it("should increase the user's balance by the withdrawn amount", async () => {
              expect(tx).to.changeTokenBalance(
                USDC,
                depositorOne,
                withdrawAmount,
              )
            })

            it("should decrease the Portal's balance by the withdrawn amount", async () => {
              expect(tx).to.changeTokenBalance(
                USDC,
                await portal.getAddress(),
                -withdrawAmount,
              )
            })
          })
        })
      },
    )
  })
})
