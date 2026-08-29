import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import { loadRecoveryManifest } from "../../helpers/recovery-manifest"
import {
  buildRecoveryBatchPayloads,
  recomputeActiveReceiptDebt,
} from "../../helpers/recovery-preflight"

const manifest = loadRecoveryManifest()

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
    expect(
      manifest.observedState?.feeInfo?.totalMintedWei,
      "manifest is missing observedState.feeInfo.totalMintedWei",
    ).to.be.a("string")
    expect(feeBefore.totalMinted).to.equal(
      BigInt(manifest.observedState.feeInfo.totalMintedWei),
    )

    // The settlement must not strand a third-party depositor: nobody whose
    // debt is being settled may be left holding more stBTC than the receipt
    // debt they retain. Validates the manifest's recorded balances too.
    const byDepositor = new Map<
      string,
      {
        settled: bigint
        manifestActiveDebt: bigint
        activeDepositIds: string[]
        manifestStbtcBalance: bigint
      }
    >()
    manifest.settlements.forEach((settlement) => {
      const existing = byDepositor.get(settlement.depositor)
      const manifestActiveDebt = BigInt(settlement.depositorActiveDebtWei)
      const manifestStbtcBalance = BigInt(settlement.depositorStbtcBalanceWei)
      if (existing) {
        expect(existing.manifestActiveDebt).to.equal(manifestActiveDebt)
        expect(existing.activeDepositIds).to.deep.equal(
          settlement.depositorActiveDepositIds,
        )
        expect(existing.manifestStbtcBalance).to.equal(manifestStbtcBalance)
        existing.settled += BigInt(settlement.amountWei)
      } else {
        byDepositor.set(settlement.depositor, {
          settled: BigInt(settlement.amountWei),
          manifestActiveDebt,
          activeDepositIds: settlement.depositorActiveDepositIds,
          manifestStbtcBalance,
        })
      }
    })
    const depositorEntries = Array.from(byDepositor.entries())
    await Promise.all(
      depositorEntries.map(async ([depositor, entry]) => {
        const holderBalance = BigInt(await stbtc.balanceOf(depositor))
        const { totalDebt: liveActiveDebt } = await recomputeActiveReceiptDebt(
          entry.activeDepositIds,
          async (depositId) => {
            const deposit = await portal.deposits(
              depositor,
              addresses.tbtc,
              depositId,
            )
            return {
              receiptMintedWei: BigInt(deposit.receiptMinted),
              migrating: Number(deposit.tbtcMigrationState) !== 0,
            }
          },
        )

        expect(holderBalance, `${depositor} stBTC balance`).to.equal(
          entry.manifestStbtcBalance,
        )
        expect(liveActiveDebt, `${depositor} live active debt`).to.equal(
          entry.manifestActiveDebt,
        )
        expect(
          holderBalance,
          `${depositor} would be left holding unredeemable stBTC`,
        ).to.be.lessThanOrEqual(liveActiveDebt - entry.settled)
      }),
    )

    // Exclusions are reviewed selection evidence too. Independently derive
    // their balances and repayable debt from every listed deposit so altered
    // debt totals or invalid listed records cannot survive the pinned fork
    // check. The preflight separately derives the complete id set from logs.
    await Promise.all(
      (manifest.strandingExclusions ?? []).map(async (exclusion) => {
        const balance = BigInt(await stbtc.balanceOf(exclusion.depositor))
        const { totalDebt } = await recomputeActiveReceiptDebt(
          exclusion.depositIds,
          async (depositId) => {
            const deposit = await portal.deposits(
              exclusion.depositor,
              addresses.tbtc,
              depositId,
            )
            expect(
              deposit.receiptMinted,
              `${exclusion.depositor}/${depositId.toString()} is not active`,
            ).to.be.greaterThan(0)
            return {
              receiptMintedWei: BigInt(deposit.receiptMinted),
              migrating: Number(deposit.tbtcMigrationState) !== 0,
            }
          },
        )
        expect(
          balance,
          `${exclusion.depositor} excluded stBTC balance`,
        ).to.equal(BigInt(exclusion.stbtcBalanceWei))
        expect(
          totalDebt,
          `${exclusion.depositor} excluded active debt`,
        ).to.equal(BigInt(exclusion.activeDebtWei))
      }),
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

    // The reviewed per-owner context for the contract's stranding guard,
    // straight from the manifest's active-deposit id lists.
    const depositorContexts = depositorEntries.map(([depositor, entry]) => ({
      depositor,
      activeDepositIds: entry.activeDepositIds.map((id) => BigInt(id)),
    }))
    const recoveryCall = Recovery.interface.encodeFunctionData("recoverTbtc", [
      settlements,
      depositorContexts,
    ])
    const { targets, values, payloads } = buildRecoveryBatchPayloads({
      portal: addresses.portal,
      proxyAdmin: addresses.proxyAdmin,
      recoveryImplementation,
      originalImplementation: addresses.originalImplementation,
      recoverCalldata: recoveryCall,
    })
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

    // Re-read every affected owner's debt after the atomic batch. This is the
    // same live invariant enforced by the recovery implementation, independent
    // of the manifest's historical aggregate.
    await Promise.all(
      depositorEntries.map(async ([depositor, entry]) => {
        const holderBalance = BigInt(await stbtc.balanceOf(depositor))
        const { totalDebt: liveDebtAfter } = await recomputeActiveReceiptDebt(
          entry.activeDepositIds,
          async (depositId) => {
            const deposit = await portal.deposits(
              depositor,
              addresses.tbtc,
              depositId,
            )
            return {
              receiptMintedWei: BigInt(deposit.receiptMinted),
              migrating: Number(deposit.tbtcMigrationState) !== 0,
            }
          },
        )
        expect(
          holderBalance,
          `${depositor} holds more stBTC than live debt after recovery`,
        ).to.be.lessThanOrEqual(liveDebtAfter)
      }),
    )

    await network.provider.send("hardhat_stopImpersonatingAccount", [
      addresses.receiptPayer,
    ])
    await network.provider.send("hardhat_stopImpersonatingAccount", [
      addresses.portalLogicOwner,
    ])
  })
})
