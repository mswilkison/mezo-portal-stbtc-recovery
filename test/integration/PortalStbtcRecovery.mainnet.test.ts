import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { recoveryManifest as manifest } from "../../helpers/recovery-manifest"

const describeFn =
  process.env.NODE_ENV === "recovery-fork-test" ? describe : describe.skip

// eslint-disable-next-line func-names
describeFn("PortalStbtcRecovery - mainnet fork", function () {
  // Forked-state reads go to a remote archive RPC; public gateways need far
  // more than mocha's default timeout.
  this.timeout(600_000)

  it("recovers Threshold's exact stBTC balance and atomically restores Portal", async () => {
    // A wrong fork pin must fail loudly instead of silently validating a
    // different block than the one governance reviewed.
    expect(
      (await ethers.provider.getBlock("latest"))!.number,
      "forked block does not match the manifest snapshot " +
        "(check MAINNET_FORK_BLOCK_NUMBER overrides)",
    ).to.equal(manifest.snapshotBlock)

    const { addresses } = manifest
    const recoveryAmount = BigInt(manifest.recoveryAmountWei)
    const settlements = manifest.settlements.map((settlement) => ({
      depositor: settlement.depositor,
      depositId: BigInt(settlement.depositId),
      amount: BigInt(settlement.amountWei),
    }))

    expect(
      settlements.reduce((total, settlement) => total + settlement.amount, 0n),
    ).to.equal(recoveryAmount)

    const implementationBefore =
      await upgrades.erc1967.getImplementationAddress(addresses.portal)
    const proxyAdmin = await upgrades.erc1967.getAdminAddress(addresses.portal)
    expect(implementationBefore).to.equal(addresses.originalImplementation)
    expect(proxyAdmin).to.equal(addresses.proxyAdmin)

    const Portal = await ethers.getContractFactory("Portal")
    const portal = new ethers.Contract(
      addresses.portal,
      Portal.interface,
      ethers.provider,
    )
    const tbtc = new ethers.Contract(
      addresses.tbtc,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    )
    const stbtc = new ethers.Contract(
      addresses.stbtc,
      [
        "function approve(address,uint256) returns (bool)",
        "function allowance(address,address) view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
        "function currentDebt(address) view returns (uint256)",
      ],
      ethers.provider,
    )

    const recipientBalanceBefore = await tbtc.balanceOf(
      addresses.collateralRecipient,
    )
    const portalBalanceBefore = await tbtc.balanceOf(addresses.portal)
    const portalDebtBefore = await stbtc.currentDebt(addresses.portal)
    const feeBefore = await portal.feeInfo(addresses.tbtc)
    const depositsBefore = await Promise.all(
      settlements.map((settlement) =>
        portal.deposits(
          settlement.depositor,
          addresses.tbtc,
          settlement.depositId,
        ),
      ),
    )

    expect(await stbtc.balanceOf(addresses.receiptPayer)).to.equal(
      recoveryAmount,
    )
    const feeInfoObserved = (
      manifest.observedState as { feeInfo: { totalMintedWei: string } }
    ).feeInfo
    expect(feeBefore.totalMinted).to.equal(
      BigInt(feeInfoObserved.totalMintedWei),
    )

    // The settlement must not strand a third-party depositor: nobody whose
    // debt is being settled may be left holding more stBTC than the receipt
    // debt they retain. Validates the manifest's recorded balances too.
    const settledByDepositor = new Map<string, bigint>()
    const activeDebtByDepositor = new Map<string, bigint>()
    manifest.settlements.forEach((settlement) => {
      settledByDepositor.set(
        settlement.depositor,
        (settledByDepositor.get(settlement.depositor) ?? 0n) +
          BigInt(settlement.amountWei),
      )
      if (settlement.depositorActiveDebtWei) {
        activeDebtByDepositor.set(
          settlement.depositor,
          BigInt(settlement.depositorActiveDebtWei),
        )
      }
    })
    await Promise.all(
      Array.from(settledByDepositor.entries()).map(
        async ([depositor, settled]) => {
          const holderBalance = BigInt(await stbtc.balanceOf(depositor))
          const recordedBalance = manifest.settlements.find(
            (settlement) => settlement.depositor === depositor,
          )?.depositorStbtcBalanceWei
          if (recordedBalance !== undefined) {
            expect(holderBalance, `${depositor} stBTC balance`).to.equal(
              BigInt(recordedBalance),
            )
          }
          const activeDebt = activeDebtByDepositor.get(depositor)
          if (activeDebt !== undefined) {
            expect(
              holderBalance,
              `${depositor} would be left holding unredeemable stBTC`,
            ).to.be.lessThanOrEqual(activeDebt - settled)
          }
        },
      ),
    )

    await network.provider.send("hardhat_setBalance", [
      addresses.receiptPayer,
      ethers.toBeHex(ethers.parseEther("1")),
    ])
    await network.provider.send("hardhat_impersonateAccount", [
      addresses.receiptPayer,
    ])
    const receiptPayer = await ethers.getSigner(addresses.receiptPayer)
    await stbtc.connect(receiptPayer).approve(addresses.portal, recoveryAmount)

    const Recovery = await ethers.getContractFactory("PortalStbtcRecovery")
    const recovery = await Recovery.deploy(
      addresses.portal,
      addresses.proxyAdmin,
      addresses.receiptPayer,
      addresses.collateralRecipient,
      addresses.tbtc,
      addresses.stbtc,
      recoveryAmount,
    )
    await recovery.waitForDeployment()
    const recoveryImplementation = await recovery.getAddress()

    const recoveryCode = await ethers.provider.getCode(recoveryImplementation)
    expect(ethers.dataLength(recoveryCode)).to.be.lessThanOrEqual(24_576)

    const recoveryCall = Recovery.interface.encodeFunctionData("recoverTbtc", [
      settlements,
    ])
    const proxyAdminInterface = new ethers.Interface([
      "function upgradeAndCall(address proxy,address implementation,bytes data) payable",
    ])
    const targets = [addresses.proxyAdmin, addresses.proxyAdmin]
    const values = [0, 0]
    const payloads = [
      proxyAdminInterface.encodeFunctionData("upgradeAndCall", [
        addresses.portal,
        recoveryImplementation,
        recoveryCall,
      ]),
      proxyAdminInterface.encodeFunctionData("upgradeAndCall", [
        addresses.portal,
        addresses.originalImplementation,
        "0x",
      ]),
    ]
    const predecessor = ethers.ZeroHash
    const salt = ethers.id("threshold-stbtc-recovery-mainnet-fork")

    const timelock = new ethers.Contract(
      addresses.proxyAdminOwnerTimelock,
      [
        "function getMinDelay() view returns (uint256)",
        "function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)",
        "function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable",
      ],
      ethers.provider,
    )
    const delay = await timelock.getMinDelay()

    await network.provider.send("hardhat_setBalance", [
      addresses.portalLogicOwner,
      ethers.toBeHex(ethers.parseEther("10")),
    ])
    await network.provider.send("hardhat_impersonateAccount", [
      addresses.portalLogicOwner,
    ])
    const governance = await ethers.getSigner(addresses.portalLogicOwner)

    await timelock
      .connect(governance)
      .scheduleBatch(targets, values, payloads, predecessor, salt, delay)
    await time.increase(delay)

    const recoveryAtPortal = Recovery.attach(addresses.portal)
    await expect(
      timelock
        .connect(governance)
        .executeBatch(targets, values, payloads, predecessor, salt),
    )
      .to.emit(recoveryAtPortal, "StbtcRecoveryCompleted")
      .withArgs(
        addresses.receiptPayer,
        addresses.collateralRecipient,
        recoveryAmount,
      )

    expect(
      await upgrades.erc1967.getImplementationAddress(addresses.portal),
    ).to.equal(addresses.originalImplementation)
    expect(await stbtc.balanceOf(addresses.receiptPayer)).to.equal(0)
    expect(
      await stbtc.allowance(addresses.receiptPayer, addresses.portal),
    ).to.equal(0)
    expect(await stbtc.currentDebt(addresses.portal)).to.equal(
      portalDebtBefore - recoveryAmount,
    )
    expect(await tbtc.balanceOf(addresses.collateralRecipient)).to.equal(
      recipientBalanceBefore + recoveryAmount,
    )
    expect(await tbtc.balanceOf(addresses.portal)).to.equal(
      portalBalanceBefore - recoveryAmount,
    )

    const feeAfter = await portal.feeInfo(addresses.tbtc)
    expect(feeAfter.totalMinted).to.equal(
      feeBefore.totalMinted - recoveryAmount,
    )

    const depositsAfter = await Promise.all(
      settlements.map((settlement) =>
        portal.deposits(
          settlement.depositor,
          addresses.tbtc,
          settlement.depositId,
        ),
      ),
    )
    settlements.forEach((settlement, index) => {
      expect(depositsAfter[index].balance).to.equal(
        depositsBefore[index].balance - settlement.amount,
      )
      expect(depositsAfter[index].receiptMinted).to.equal(
        depositsBefore[index].receiptMinted - settlement.amount,
      )
      expect(depositsAfter[index].feeOwed).to.be.greaterThan(0)
      expect(
        depositsAfter[index].balance -
          depositsAfter[index].receiptMinted -
          depositsAfter[index].feeOwed,
      ).to.be.greaterThanOrEqual(0)
    })

    await network.provider.send("hardhat_stopImpersonatingAccount", [
      addresses.receiptPayer,
    ])
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      addresses.portalLogicOwner,
    ])
  })
})
