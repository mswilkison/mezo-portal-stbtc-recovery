import chaiAsPromised from "chai-as-promised"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers } from "hardhat"
import {
  to1ePrecision,
  to1e18,
} from "@keep-network/hardhat-helpers/dist/number"
import { use, expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, MockSTBTC, MockWBTC, Portal } from "../../typechain"
import deployPortal from "../fixtures/deployPortal"
import { TokenAbility } from "../../types"

use(chaiAsPromised)

describe("Integration tests - Receipt tokens", () => {
  let TBTC: MockERC20
  let WBTC: MockWBTC
  let stBTC: MockSTBTC
  let USDC: MockERC20
  let tbtcAddress: string
  let wbtcAddress: string
  let stbtcAddress: string
  let usdcAddress: string
  let portal: Portal
  let depositorOne: HardhatEthersSigner
  let deployer: HardhatEthersSigner

  const depositAmount = to1e18(1)
  const wbtcDepositAmount = to1ePrecision(1, 8)
  const noLockPeriod = 0
  const mintCap = 90

  const tbtcDepositId = 1
  const wbtcDepositId = 2
  const usdcDepositId = 3

  const receiptAmount = (depositAmount * BigInt(mintCap)) / 100n

  before(async () => {
    ;({
      TBTC,
      WBTC,
      USDC,
      stBTC,
      tbtcAddress,
      wbtcAddress,
      stbtcAddress,
      usdcAddress,
      portal,
      deployer,
      depositorOne,
    } = await loadFixture(deployPortal))

    await TBTC.connect(depositorOne).approve(
      await portal.getAddress(),
      depositAmount,
    )
    await WBTC.connect(depositorOne).approve(
      await portal.getAddress(),
      wbtcDepositAmount,
    )
    await USDC.connect(depositorOne).approve(
      await portal.getAddress(),
      depositAmount,
    )

    await portal.connect(deployer).addSupportedToken({
      token: usdcAddress,
      tokenAbility: TokenAbility.DepositAndLock,
    })

    // depositId = 1
    await portal
      .connect(depositorOne)
      .deposit(tbtcAddress, depositAmount, noLockPeriod)
    // depositId = 2
    await portal
      .connect(depositorOne)
      .deposit(wbtcAddress, wbtcDepositAmount, noLockPeriod)
    // depositId = 3
    await portal
      .connect(depositorOne)
      .deposit(usdcAddress, depositAmount, noLockPeriod)

    await portal
      .connect(deployer)
      .setReceiptParams(tbtcAddress, 2, mintCap, stbtcAddress)
    await portal
      .connect(deployer)
      .setReceiptParams(wbtcAddress, 3, mintCap, stbtcAddress)
    await portal
      .connect(deployer)
      .setReceiptParams(usdcAddress, 0, mintCap, stbtcAddress)
  })

  context("when minting receipt tokens", () => {
    before(async () => {
      await portal
        .connect(depositorOne)
        .mintReceipt(tbtcAddress, tbtcDepositId, receiptAmount)

      await portal
        .connect(depositorOne)
        .mintReceipt(wbtcAddress, wbtcDepositId, receiptAmount)

      await portal
        .connect(depositorOne)
        .mintReceipt(usdcAddress, usdcDepositId, receiptAmount)
    })

    it("should mint receipt tokens to depositor", async () => {
      expect(await stBTC.balanceOf(await depositorOne.getAddress())).to.equal(
        receiptAmount * 3n,
      )
    })

    it("should update deposits", async () => {
      const tbtcDeposit = await portal.getDeposit(
        depositorOne,
        tbtcAddress,
        tbtcDepositId,
      )

      const wbtcDeposit = await portal.getDeposit(
        depositorOne,
        wbtcAddress,
        wbtcDepositId,
      )

      const usdcDeposit = await portal.getDeposit(
        depositorOne,
        usdcAddress,
        usdcDepositId,
      )

      expect(tbtcDeposit.receiptMinted).to.equal(receiptAmount)
      expect(wbtcDeposit.receiptMinted).to.equal(receiptAmount)
      expect(usdcDeposit.receiptMinted).to.equal(receiptAmount)
    })

    it("should update fee info", async () => {
      const tbtcFeeInfo = await portal.feeInfo(tbtcAddress)
      const wbtcFeeInfo = await portal.feeInfo(wbtcAddress)
      const usdcFeeInfo = await portal.feeInfo(usdcAddress)

      expect(tbtcFeeInfo.totalMinted).to.equal(receiptAmount)
      expect(tbtcFeeInfo.feeCollected).to.equal(0)
      expect(wbtcFeeInfo.totalMinted).to.equal(receiptAmount)
      expect(wbtcFeeInfo.feeCollected).to.equal(0)
      expect(usdcFeeInfo.totalMinted).to.equal(receiptAmount)
      expect(usdcFeeInfo.feeCollected).to.equal(0)
    })
  })

  context("when repaying receipt tokens", () => {
    before(async () => {
      await helpers.time.increaseTime(365 * 86400)

      await stBTC
        .connect(depositorOne)
        .approve(await portal.getAddress(), receiptAmount * 3n)

      await portal
        .connect(depositorOne)
        .repayReceipt(tbtcAddress, tbtcDepositId, receiptAmount)
      await portal
        .connect(depositorOne)
        .repayReceipt(wbtcAddress, wbtcDepositId, receiptAmount)
      await portal
        .connect(depositorOne)
        .repayReceipt(usdcAddress, usdcDepositId, receiptAmount)
    })

    it("should repay receipt from depositor wallet", async () => {
      expect(await stBTC.balanceOf(await depositorOne.getAddress())).to.equal(0)
    })

    it("should update deposits", async () => {
      const tbtcDeposit = await portal.getDeposit(
        depositorOne,
        tbtcAddress,
        tbtcDepositId,
      )

      const wbtcDeposit = await portal.getDeposit(
        depositorOne,
        wbtcAddress,
        wbtcDepositId,
      )

      const usdcDeposit = await portal.getDeposit(
        depositorOne,
        usdcAddress,
        usdcDepositId,
      )

      expect(tbtcDeposit.receiptMinted).to.equal(0)
      expect(wbtcDeposit.receiptMinted).to.equal(0)
      expect(usdcDeposit.receiptMinted).to.equal(0)

      expect(tbtcDeposit.feeOwed).to.not.equal(0)
      expect(wbtcDeposit.feeOwed).to.not.equal(0)
      expect(usdcDeposit.feeOwed).to.equal(0) // USDC has 0% fee
    })

    it("should update fee info", async () => {
      const tbtcFeeInfo = await portal.feeInfo(tbtcAddress)
      const wbtcFeeInfo = await portal.feeInfo(wbtcAddress)
      const usdcFeeInfo = await portal.feeInfo(usdcAddress)

      expect(tbtcFeeInfo.totalMinted).to.equal(0)
      expect(tbtcFeeInfo.feeCollected).to.equal(0)
      expect(wbtcFeeInfo.totalMinted).to.equal(0)
      expect(wbtcFeeInfo.feeCollected).to.equal(0)
      expect(usdcFeeInfo.totalMinted).to.equal(0)
      expect(usdcFeeInfo.feeCollected).to.equal(0)
    })
  })

  context("when withdrawing deposits partially", () => {
    let depositorUsdcBalanceBefore = 0n

    before(async () => {
      depositorUsdcBalanceBefore = await USDC.balanceOf(
        await depositorOne.getAddress(),
      )
      await portal
        .connect(depositorOne)
        .withdrawPartially(usdcAddress, usdcDepositId, depositAmount / 2n)
    })

    it("should transfer tokens to depositor", async () => {
      expect(await USDC.balanceOf(await depositorOne.getAddress())).to.equal(
        depositorUsdcBalanceBefore + depositAmount / 2n,
      )
    })

    it("should update deposits", async () => {
      const usdcDeposit = await portal.getDeposit(
        depositorOne,
        usdcAddress,
        usdcDepositId,
      )

      expect(usdcDeposit.balance).to.equal(depositAmount / 2n)
    })

    it("should not update fee info", async () => {
      const usdcFeeInfo = await portal.feeInfo(usdcAddress)

      expect(usdcFeeInfo.feeCollected).to.equal(0)
    })
  })

  context("when withdrawing deposits fully", () => {
    let depositorUsdcBalanceBefore = 0n
    let depositorTbtcBalanceBefore = 0n
    let depositorWbtcBalanceBefore = 0n

    let tbtcDepositFeeOwed = 0n
    let wbtcDepositFeeOwed = 0n

    before(async () => {
      depositorUsdcBalanceBefore = await USDC.balanceOf(
        await depositorOne.getAddress(),
      )
      depositorTbtcBalanceBefore = await TBTC.balanceOf(
        await depositorOne.getAddress(),
      )
      depositorWbtcBalanceBefore = await WBTC.balanceOf(
        await depositorOne.getAddress(),
      )

      tbtcDepositFeeOwed = (
        await portal.getDeposit(depositorOne, tbtcAddress, tbtcDepositId)
      ).feeOwed

      const wbtcDepositFeeOwedHighPrecision = (
        await portal.getDeposit(depositorOne, wbtcAddress, wbtcDepositId)
      ).feeOwed

      wbtcDepositFeeOwed = wbtcDepositFeeOwedHighPrecision / 10n ** 10n

      await portal.connect(depositorOne).withdraw(usdcAddress, usdcDepositId)
      await portal.connect(depositorOne).withdraw(tbtcAddress, tbtcDepositId)
      await portal.connect(depositorOne).withdraw(wbtcAddress, wbtcDepositId)
    })

    it("should transfer tokens to depositor", async () => {
      expect(await USDC.balanceOf(await depositorOne.getAddress())).to.equal(
        depositorUsdcBalanceBefore + depositAmount / 2n,
      )
      expect(await TBTC.balanceOf(await depositorOne.getAddress())).to.equal(
        depositorTbtcBalanceBefore + depositAmount - tbtcDepositFeeOwed,
      )
      expect(await WBTC.balanceOf(await depositorOne.getAddress())).to.equal(
        depositorWbtcBalanceBefore + wbtcDepositAmount - wbtcDepositFeeOwed,
      )
    })

    it("should update fee info", async () => {
      const tbtcFeeInfo = await portal.feeInfo(tbtcAddress)
      const wbtcFeeInfo = await portal.feeInfo(wbtcAddress)
      const usdcFeeInfo = await portal.feeInfo(usdcAddress)

      expect(tbtcFeeInfo.feeCollected).to.equal(tbtcDepositFeeOwed)
      expect(wbtcFeeInfo.feeCollected).to.equal(wbtcDepositFeeOwed)
      expect(usdcFeeInfo.feeCollected).to.equal(0)
    })
  })
})
