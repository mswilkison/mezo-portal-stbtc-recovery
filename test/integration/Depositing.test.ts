import chaiAsPromised from "chai-as-promised"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { helpers, ethers } from "hardhat"
import { use, expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MockERC20, Portal } from "../../typechain"
import deployPortal from "../fixtures/deployPortal"

use(chaiAsPromised)

describe("Integration tests - Depositing", () => {
  let TBTC: MockERC20
  let WBTC: MockERC20
  let tbtcAddress: string
  let wbtcAddress: string
  let portal: Portal
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner

  const depositAmount = ethers.parseEther("1")
  const noLockPeriod = 0
  const weekPeriod = 60 * 60 * 24 * 7 // 1 week
  const minLockPeriod = weekPeriod * 4 // 4 weeks
  const maxLockPeriod = 60 * 60 * 24 * 7 * 39 // 39 weeks = ~9 months

  let depositorOneTBTCBalanceBefore: bigint
  let depositorOneWBTCBalanceBefore: bigint

  let depositorTwoTBTCBalanceBefore: bigint
  let depositorTwoWBTCBalanceBefore: bigint

  let depositorOneTBTCDepositExpectedUnlockTime: number
  let depositorTwoTBTCDepositExpectedUnlockTime: number

  let depositorOneWBTCDepositExpectedUnlockTime: number
  let depositorTwoWBTCDepositExpectedUnlockTime: number

  before(async () => {
    ;({
      TBTC,
      WBTC,
      tbtcAddress,
      wbtcAddress,
      portal,
      depositorOne,
      depositorTwo,
    } = await loadFixture(deployPortal))

    depositorOneTBTCBalanceBefore = await TBTC.balanceOf(depositorOne.address)
    depositorOneWBTCBalanceBefore = await WBTC.balanceOf(depositorOne.address)
    depositorTwoTBTCBalanceBefore = await TBTC.balanceOf(depositorTwo.address)
    depositorTwoWBTCBalanceBefore = await WBTC.balanceOf(depositorTwo.address)

    await TBTC.connect(depositorOne).approve(
      await portal.getAddress(),
      depositAmount,
    )
    await TBTC.connect(depositorTwo).approve(
      await portal.getAddress(),
      depositAmount,
    )
    await WBTC.connect(depositorOne).approve(
      await portal.getAddress(),
      depositAmount,
    )
    await WBTC.connect(depositorTwo).approve(
      await portal.getAddress(),
      depositAmount,
    )
  })

  context("when no token was deposited yet", () => {
    it("should have depositCount equal to 0", async () => {
      expect(await portal.depositCount()).to.be.equal(0)
    })

    it("should have no tokens deposited", async () => {
      expect(await TBTC.balanceOf(await portal.getAddress())).to.be.equal(0)
      expect(await WBTC.balanceOf(await portal.getAddress())).to.be.equal(0)
    })
  })

  context("when depositing tokens", () => {
    before(async () => {
      // First deposit - depositor #1 deposits TBTC with no lock
      await portal
        .connect(depositorOne)
        .deposit(tbtcAddress, depositAmount, noLockPeriod)

      depositorOneTBTCDepositExpectedUnlockTime =
        await helpers.time.lastBlockTime()

      // Second deposit - depositor #2 deposits TBTC with no lock
      await portal
        .connect(depositorTwo)
        .deposit(tbtcAddress, depositAmount, noLockPeriod)

      depositorTwoTBTCDepositExpectedUnlockTime =
        await helpers.time.lastBlockTime()
    })

    it("should update depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(2)
    })

    it("should update token balances", async () => {
      expect(await TBTC.balanceOf(await portal.getAddress())).to.be.equal(
        depositAmount * 2n,
      )
      expect(await TBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneTBTCBalanceBefore - depositAmount,
      )
      expect(await TBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoTBTCBalanceBefore - depositAmount,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        tbtcAddress,
        1,
      )

      expect(depositorOneDeposit.balance).to.be.equal(depositAmount)
      expect(depositorOneDeposit.unlockAt).to.be.equal(
        depositorOneTBTCDepositExpectedUnlockTime,
      )

      const depositorTwoDeposit = await portal.getDeposit(
        depositorTwo.address,
        tbtcAddress,
        2,
      )

      expect(depositorTwoDeposit.balance).to.be.equal(depositAmount)
      expect(depositorTwoDeposit.unlockAt).to.be.equal(
        depositorTwoTBTCDepositExpectedUnlockTime,
      )
    })
  })

  context("when locking existing deposits", () => {
    before(async () => {
      // Locking first deposit - depositor #1 locks TBTC for a year
      await portal.connect(depositorOne).lock(tbtcAddress, 1, maxLockPeriod)

      depositorOneTBTCDepositExpectedUnlockTime =
        (await helpers.time.lastBlockTime()) + maxLockPeriod
    })

    it("should not change depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(2)
    })

    it("should not change token balances", async () => {
      expect(await TBTC.balanceOf(await portal.getAddress())).to.be.equal(
        depositAmount * 2n,
      )
      expect(await TBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneTBTCBalanceBefore - depositAmount,
      )
      expect(await TBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoTBTCBalanceBefore - depositAmount,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        tbtcAddress,
        1,
      )

      expect(depositorOneDeposit.balance).to.be.equal(depositAmount)
      expect(depositorOneDeposit.unlockAt).to.be.equal(
        depositorOneTBTCDepositExpectedUnlockTime,
      )

      const depositorTwoDeposit = await portal.getDeposit(
        depositorTwo.address,
        tbtcAddress,
        2,
      )

      expect(depositorTwoDeposit.balance).to.be.equal(depositAmount)
      expect(depositorTwoDeposit.unlockAt).to.be.equal(
        depositorTwoTBTCDepositExpectedUnlockTime,
      )
    })
  })

  context("when depositing tokens with a lock", () => {
    before(async () => {
      // Third deposit - depositor #1 deposits WBTC with min lock
      await portal
        .connect(depositorOne)
        .deposit(wbtcAddress, depositAmount, minLockPeriod)

      depositorOneWBTCDepositExpectedUnlockTime =
        (await helpers.time.lastBlockTime()) + minLockPeriod

      // Fourth deposit - depositor #2 deposits WBTC with max lock
      await portal
        .connect(depositorTwo)
        .deposit(wbtcAddress, depositAmount, maxLockPeriod)

      depositorTwoWBTCDepositExpectedUnlockTime =
        (await helpers.time.lastBlockTime()) + maxLockPeriod
    })

    it("should update depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(4)
    })

    it("should update token balances", async () => {
      expect(await WBTC.balanceOf(await portal.getAddress())).to.be.equal(
        depositAmount * 2n,
      )
      expect(await WBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneWBTCBalanceBefore - depositAmount,
      )
      expect(await WBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoWBTCBalanceBefore - depositAmount,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        wbtcAddress,
        3,
      )

      expect(depositorOneDeposit.balance).to.be.equal(depositAmount)
      expect(depositorOneDeposit.unlockAt).to.be.equal(
        depositorOneWBTCDepositExpectedUnlockTime,
      )

      const depositorTwoDeposit = await portal.getDeposit(
        depositorTwo.address,
        wbtcAddress,
        4,
      )

      expect(depositorTwoDeposit.balance).to.be.equal(depositAmount)
      expect(depositorTwoDeposit.unlockAt).to.be.equal(
        depositorTwoWBTCDepositExpectedUnlockTime,
      )
    })
  })

  context("when extending the lock of existing deposits", () => {
    before(async () => {
      // Extending third deposit - depositor #1 extends WBTC lock to max lock period
      await portal.connect(depositorOne).lock(wbtcAddress, 3, maxLockPeriod)

      depositorOneWBTCDepositExpectedUnlockTime =
        (await helpers.time.lastBlockTime()) + maxLockPeriod
    })

    it("should not change depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(4)
    })

    it("should not change token balances", async () => {
      expect(await WBTC.balanceOf(await portal.getAddress())).to.be.equal(
        depositAmount * 2n,
      )
      expect(await WBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneWBTCBalanceBefore - depositAmount,
      )
      expect(await WBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoWBTCBalanceBefore - depositAmount,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        wbtcAddress,
        3,
      )

      expect(depositorOneDeposit.balance).to.be.equal(depositAmount)
      expect(depositorOneDeposit.unlockAt).to.be.equal(
        depositorOneWBTCDepositExpectedUnlockTime,
      )
    })
  })

  context("when withdrawing deposits", () => {
    before(async () => {
      await helpers.time.increaseTime(maxLockPeriod)
      // First withdrawal - depositor #1 withdraws TBTC
      await portal.connect(depositorOne).withdraw(tbtcAddress, 1)

      // Second withdrawal - depositor #2 withdraws TBTC
      await portal.connect(depositorTwo).withdraw(tbtcAddress, 2)

      // Third withdrawal - depositor #1 withdraws WBTC
      await portal.connect(depositorOne).withdraw(wbtcAddress, 3)

      // Fourth withdrawal - depositor #2 withdraws WBTC
      await portal.connect(depositorTwo).withdraw(wbtcAddress, 4)
    })

    it("should not change depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(4)
    })

    it("should update token balances", async () => {
      expect(await TBTC.balanceOf(await portal.getAddress())).to.be.equal(0)
      expect(await WBTC.balanceOf(await portal.getAddress())).to.be.equal(0)
      expect(await TBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneTBTCBalanceBefore,
      )
      expect(await TBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoTBTCBalanceBefore,
      )
      expect(await WBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneWBTCBalanceBefore,
      )
      expect(await WBTC.balanceOf(depositorTwo.address)).to.be.equal(
        depositorTwoWBTCBalanceBefore,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        tbtcAddress,
        1,
      )

      expect(depositorOneDeposit.balance).to.be.equal(0)

      const depositorTwoDeposit = await portal.getDeposit(
        depositorTwo.address,
        tbtcAddress,
        2,
      )

      expect(depositorTwoDeposit.balance).to.be.equal(0)

      const depositorOneWBTC = await portal.getDeposit(
        depositorOne.address,
        wbtcAddress,
        3,
      )

      expect(depositorOneWBTC.balance).to.be.equal(0)

      const depositorTwoWBTC = await portal.getDeposit(
        depositorTwo.address,
        wbtcAddress,
        4,
      )

      expect(depositorTwoWBTC.balance).to.be.equal(0)
    })
  })

  context("when depositing tokens again", () => {
    before(async () => {
      await TBTC.connect(depositorOne).approve(
        await portal.getAddress(),
        depositAmount,
      )

      // Fifth deposit - depositor #1 deposits TBTC with no lock
      await portal
        .connect(depositorOne)
        .deposit(tbtcAddress, depositAmount, noLockPeriod)

      depositorOneTBTCDepositExpectedUnlockTime =
        await helpers.time.lastBlockTime()
    })

    it("should update depositCount", async () => {
      expect(await portal.depositCount()).to.be.equal(5)
    })

    it("should update token balances", async () => {
      expect(await TBTC.balanceOf(await portal.getAddress())).to.be.equal(
        depositAmount,
      )
      expect(await TBTC.balanceOf(depositorOne.address)).to.be.equal(
        depositorOneTBTCBalanceBefore - depositAmount,
      )
    })

    it("should update saved deposits details", async () => {
      const depositorOneDeposit = await portal.getDeposit(
        depositorOne.address,
        tbtcAddress,
        5,
      )

      expect(depositorOneDeposit.balance).to.be.equal(depositAmount)
      expect(depositorOneDeposit.unlockAt).to.be.equal(
        depositorOneTBTCDepositExpectedUnlockTime,
      )
    })
  })
})
