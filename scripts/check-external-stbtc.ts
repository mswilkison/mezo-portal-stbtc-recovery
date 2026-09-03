import { ethers } from "hardhat"
import {
  EXTERNAL_STBTC_REVIEW_CONFIRMATION,
  createEthersExternalStbtcReader,
  evaluateExternalStbtcGate,
  screenExternalStbtcHoldings,
} from "../helpers/external-stbtc"
import {
  assertManifestSnapshotCanonical,
  loadRecoveryManifest,
} from "../helpers/recovery-manifest"
import { assertPinnedBlockHashUnchanged } from "../helpers/recovery-preflight"

// Produces the automated half of the selected-depositor external-stBTC
// review. Transfer history can find direct recipient venues, but it cannot
// discover LP tokens received from somebody else, LP tokens moved into a
// gauge/vault, or another address controlled by the depositor. Consequently
// this command never calls an automated-only result CLEAN: it also requires
// the explicit manual-review confirmation below.
//
//   MAINNET_RPC_URL=<archive rpc> \
//   RECOVERY_EXTERNAL_STBTC_REVIEW=I_CONFIRM_NO_EXTERNAL_STBTC_CLAIMS \
//   npm run check:external-stbtc
//
// Set the confirmation only after manually checking every selected
// depositor's controlled addresses and all LP/share/gauge/vault positions.
// If ownership or protocol coverage cannot be established, exclude that
// depositor or reduce its settlement instead of attesting.

async function main() {
  const manifest = loadRecoveryManifest()
  await assertManifestSnapshotCanonical(ethers.provider, manifest)
  const requestedBlock = process.env.CHECK_BLOCK
    ? Number(process.env.CHECK_BLOCK)
    : await ethers.provider.getBlockNumber()
  const block = await ethers.provider.getBlock(requestedBlock)
  if (!block) {
    throw new Error(`external stBTC review block ${requestedBlock} not found`)
  }
  const blockNumber = block.number
  const stbtcAddress = manifest.addresses.stbtc
  const depositors = Array.from(
    new Set(manifest.settlements.map((s) => ethers.getAddress(s.depositor))),
  )
  const reader = createEthersExternalStbtcReader(
    ethers.provider,
    manifest.addresses.tbtc,
    stbtcAddress,
    blockNumber,
    block.hash,
  )
  const report = await screenExternalStbtcHoldings(depositors, reader)
  await assertManifestSnapshotCanonical(ethers.provider, manifest)
  await assertPinnedBlockHashUnchanged(
    ethers.provider,
    block.number,
    block.hash,
  )
  const gate = evaluateExternalStbtcGate(
    report,
    process.env.RECOVERY_EXTERNAL_STBTC_REVIEW,
  )

  // eslint-disable-next-line no-console
  const print = console.log
  print(
    `stBTC external-holdings screen at block ${blockNumber} (${block.hash}, ` +
      "canonical hash revalidated after scan)",
  )
  print(`token ${stbtcAddress}, ${depositors.length} settled depositors\n`)

  report.depositors.forEach((depositor) => {
    print(depositor.depositor)
    print(
      `  minted/received ${ethers.formatEther(
        depositor.totalReceivedWei,
      )} stBTC, sent ${ethers.formatEther(
        depositor.totalSentWei,
      )} stBTC, wallet balance now ${ethers.formatEther(
        depositor.walletBalanceWei,
      )} (wallet balance is handled atomically by the recovery contract)`,
    )
    depositor.destinations.forEach((destination) => {
      let details =
        `    -> ${destination.destination} ` +
        `${destination.isContract ? "contract" : "EOA"} ` +
        `${ethers.formatEther(destination.amountSentWei)} sent`
      if (destination.venueStbtcBalanceWei !== undefined) {
        details += `; venue holds ${ethers.formatEther(
          destination.venueStbtcBalanceWei,
        )} stBTC`
      }
      if (destination.isContract) {
        if (destination.depositorClaimBalanceWei !== undefined) {
          details += `; depositor's raw share balance ${destination.depositorClaimBalanceWei.toString()}${
            destination.symbol ? ` (${destination.symbol})` : ""
          }`
        } else if (destination.claimBalanceError) {
          details += `; share balance UNVERIFIABLE: ${destination.claimBalanceError}`
        }
      }
      if (destination.adapter) {
        details += `; ${destination.adapter} ${destination.resolution}: ${destination.protocolEvidence}`
      }
      print(details)
    })
    depositor.positions.forEach((position) => {
      const positionId =
        position.adapter === "uniswap-v3-nft"
          ? `NFT ${position.tokenId.toString()}`
          : `core ${position.tickLower}/${position.tickUpper}`
      print(
        `    Uniswap V3 ${positionId}: liquidity ` +
          `${position.liquidity.toString()}, owed ` +
          `${position.tokensOwed0.toString()}/${position.tokensOwed1.toString()}`,
      )
    })
    print("")
  })

  print(`AUTOMATED LIMIT: ${report.limitation}`)
  if (report.unverifiableReasons.length > 0) {
    print("AUTOMATED UNRESOLVED (always blocking):")
    report.unverifiableReasons.forEach((reason) => print(`  - ${reason}`))
  }
  if (!gate.passed) {
    print("RESULT: BLOCKED. Do not approve or execute this recovery:")
    gate.blockingReasons.forEach((reason) => print(`  - ${reason}`))
    process.exitCode = 1
    return
  }

  print(
    "RESULT: PASSED. Direct recipient venues have no detected claim and " +
      "the operator supplied the mandatory manual external-holdings " +
      `confirmation (${EXTERNAL_STBTC_REVIEW_CONFIRMATION}).`,
  )
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
