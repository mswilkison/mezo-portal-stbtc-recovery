import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - withdrawAsLiquidityTreasury method", () => {
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

  describe("withdrawAsLiquidityTreasury", () => {
    context("when trying to withdraw incorrectly", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      context("when sender is not the liquidity treasury multisig", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(depositorOne)
              .withdrawAsLiquidityTreasury(usdcAddress, withdrawAmount),
          )
            .to.be.revertedWithCustomError(portal, "SenderNotLiquidityTreasury")
            .withArgs(depositorOne.address)
        })
      })

      context("when the provided amount is 0", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(liquidityTreasuryMultisig)
              .withdrawAsLiquidityTreasury(usdcAddress, 0),
          )
            .to.be.revertedWithCustomError(portal, "IncorrectAmount")
            .withArgs(0)
        })
      })

      context(
        "when the provided token is not managed by the liquidity treasury",
        () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(liquidityTreasuryMultisig)
                .withdrawAsLiquidityTreasury(usdcAddress, withdrawAmount),
            )
              .to.be.revertedWithCustomError(
                portal,
                "AssetNotManagedByLiquidityTreasury",
              )
              .withArgs(usdcAddress)
          })
        },
      )
    })

    context("when trying to withdraw correctly", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await portal.connect(deployer).addSupportedToken({
          token: usdcAddress,
          tokenAbility: TokenAbility.DepositAndLock,
        })

        await portal
          .connect(deployer)
          .setAssetAsLiquidityTreasuryManaged(usdcAddress, true)

        await USDC.connect(depositorOne).approve(
          await portal.getAddress(),
          depositAmount,
        )

        await portal
          .connect(depositorOne)
          .deposit(usdcAddress, depositAmount, noLockPeriod)

        tx = await portal
          .connect(liquidityTreasuryMultisig)
          .withdrawAsLiquidityTreasury(usdcAddress, withdrawAmount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a WithdrawnByLiquidityTreasury event", async () => {
        await expect(tx)
          .to.emit(portal, "WithdrawnByLiquidityTreasury")
          .withArgs(usdcAddress, withdrawAmount)
      })

      it("should increase the balance of the liquidity treasury multisig", async () => {
        expect(tx).to.changeTokenBalance(
          USDC,
          liquidityTreasuryMultisig,
          withdrawAmount,
        )
      })

      it("should decrease the deposited balance", async () => {
        expect(tx).to.changeTokenBalance(
          USDC,
          await portal.getAddress(),
          -withdrawAmount,
        )
      })
    })
  })
})
