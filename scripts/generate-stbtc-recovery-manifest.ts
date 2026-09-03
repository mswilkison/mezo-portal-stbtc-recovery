import { writeFileSync } from "fs"
import { join } from "path"
import { artifacts, ethers } from "hardhat"
import * as anchors from "../helpers/recovery-anchors"
import type { RecoveryManifest } from "../helpers/recovery-manifest"
import {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  assertPinnedBlockHashUnchanged,
  effectiveFeeIntegralAt,
  pinnedBlockContext,
  projectedFeeOwed,
} from "../helpers/recovery-preflight"

// Regenerates the recovery manifest from chain state so a re-pin is a
// reproducible, reviewable operation instead of a hand-edit. Usage:
//
//   MAINNET_RPC_URL=<archive rpc> \
//   npx hardhat run scripts/generate-stbtc-recovery-manifest.ts --network mainnet
//
// Environment:
//   MANIFEST_BLOCK        pin block (default: latest - 5)
//   SCAN_START_BLOCK      first block scanned for ReceiptMinted (default 19000000)
//   SCAN_CHUNK            getLogs chunk size in blocks (default 50000)
//   STRANDING_DUST_WEI    max stBTC a depositor may hold and still be
//                         selected for settlement (default 1e12)
//
// Selection policy: largest active tBTC receipt debts first, restricted to
// depositors whose stBTC holdings do not exceed the dust threshold. A
// depositor still holding stBTC can repay their own debt through the normal
// Portal path; zeroing their debt would leave that stBTC unredeemable —
// recreating for them the exact stranded position this recovery cures for
// Threshold. Excluded depositors are recorded in the manifest for review.

const RECEIPT_MINTED_TOPIC = ethers.id(
  "ReceiptMinted(address,address,uint256,uint256)",
)

type ActiveDeposit = {
  depositor: string
  depositId: bigint
  balance: bigint
  receiptMinted: bigint
  feeOwed: bigint
  lastFeeIntegral: bigint
  migrationState: number
  projectedFee: bigint
  collateralMargin: bigint
}

function fail(message: string): never {
  throw new Error(`Manifest generation failed: ${message}`)
}

function envPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${name}="${raw}" is not a positive integer`)
  }
  return value
}

function envWeiAmount(name: string, fallback: bigint): bigint {
  const raw = process.env[name]
  if (raw === undefined || raw === "") {
    return fallback
  }
  try {
    const value = BigInt(raw)
    if (value < 0n) {
      throw new Error("negative")
    }
    return value
  } catch {
    return fail(`${name}="${raw}" is not a non-negative wei amount`)
  }
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.error(message)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) {
          return
        }
        // eslint-disable-next-line no-await-in-loop
        results[index] = await worker(items[index])
      }
    },
  )
  await Promise.all(runners)
  return results
}

async function scanReceiptMintedDeposits(
  portal: string,
  tbtcTopic: string,
  fromBlock: number,
  toBlock: number,
  initialChunk: number,
): Promise<Map<string, { depositor: string; depositId: bigint }>> {
  const found = new Map<string, { depositor: string; depositId: bigint }>()
  let start = fromBlock
  let chunk = initialChunk
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock)
    try {
      // eslint-disable-next-line no-await-in-loop
      const logs = await ethers.provider.send("eth_getLogs", [
        {
          address: portal,
          fromBlock: ethers.toQuantity(start),
          toBlock: ethers.toQuantity(end),
          topics: [RECEIPT_MINTED_TOPIC, null, tbtcTopic],
        },
      ])
      logs.forEach((entry: { topics: string[] }) => {
        const depositor = ethers.getAddress(`0x${entry.topics[1].slice(-40)}`)
        const depositId = BigInt(entry.topics[3])
        found.set(`${depositor}-${depositId.toString()}`, {
          depositor,
          depositId,
        })
      })
      start = end + 1
      if (chunk < initialChunk) {
        chunk = Math.min(initialChunk, chunk * 2)
      }
    } catch (error) {
      if (chunk <= 1000) {
        throw error
      }
      chunk = Math.floor(chunk / 2)
      log(`  getLogs range rejected, retrying with chunk=${chunk}`)
    }
  }
  return found
}

async function main() {
  const network = await ethers.provider.getNetwork()
  if (network.chainId !== 1n) {
    fail(`expected Ethereum mainnet, connected to chain ${network.chainId}`)
  }

  const head = await ethers.provider.getBlockNumber()
  const pinBlock = envPositiveInteger("MANIFEST_BLOCK", head - 5)
  const scanStart = envPositiveInteger("SCAN_START_BLOCK", 19000000)
  const scanChunk = envPositiveInteger("SCAN_CHUNK", 50000)
  const dustWei = envWeiAmount("STRANDING_DUST_WEI", 1000000000000n)

  const block = await ethers.provider.getBlock(pinBlock)
  if (!block) {
    fail(`block ${pinBlock} not found`)
  }
  const { rpcBlockTag, callOverrides: blockTag } = pinnedBlockContext(
    block.number,
    block.hash,
  )

  // Counterparties come from the reviewed anchors, NOT from the previous
  // manifest. Copying them forward made the manifest its own authority for
  // the one value nothing on chain anchors (the tBTC destination), so a
  // corrupted address would survive regeneration and be "verified" against
  // itself by the bytecode verifier.
  const addresses = {
    portal: ethers.getAddress(anchors.PORTAL),
    portalLogicOwner: ethers.getAddress(anchors.PORTAL_LOGIC_OWNER),
    receiptPayer: ethers.getAddress(anchors.RECEIPT_PAYER),
    collateralRecipient: ethers.getAddress(anchors.COLLATERAL_RECIPIENT),
  }

  log(`Pinning manifest at block ${pinBlock} (${block.timestamp})`)

  const originalImplementation = ethers.getAddress(
    `0x${(
      await ethers.provider.send("eth_getStorageAt", [
        addresses.portal,
        IMPLEMENTATION_SLOT,
        rpcBlockTag,
      ])
    ).slice(-40)}`,
  )
  const proxyAdmin = ethers.getAddress(
    `0x${(
      await ethers.provider.send("eth_getStorageAt", [
        addresses.portal,
        ADMIN_SLOT,
        rpcBlockTag,
      ])
    ).slice(-40)}`,
  )

  const implementationCode = await ethers.provider.getCode(
    originalImplementation,
    blockTag.blockTag,
  )
  const implementationRuntimeHash = ethers.keccak256(implementationCode)
  const portalArtifact = await artifacts.readArtifact("Portal")
  const compiledHash = ethers.keccak256(portalArtifact.deployedBytecode)
  // Hard failure, not a warning. A mismatch means this repository's Portal
  // reconstruction no longer describes the live implementation, so the
  // storage-layout review the whole recovery rests on is void. Emitting a
  // manifest anyway would silently re-anchor the provenance gate to whatever
  // is live, since the gate compares the artifact against the manifest.
  if (compiledHash !== anchors.IMPLEMENTATION_RUNTIME_HASH) {
    fail(
      `compiled Portal runtime hash ${compiledHash} does not match the ` +
        `reviewed anchor ${anchors.IMPLEMENTATION_RUNTIME_HASH} ` +
        "(helpers/recovery-anchors.ts / UPSTREAM.md); rebuild with " +
        "evmVersion paris or re-review the reconstruction",
    )
  }
  if (implementationRuntimeHash !== anchors.IMPLEMENTATION_RUNTIME_HASH) {
    fail(
      `the live Portal implementation (${originalImplementation}, runtime ` +
        `hash ${implementationRuntimeHash}) is not the reviewed anchor ` +
        `${anchors.ORIGINAL_IMPLEMENTATION}. The Portal has been upgraded: ` +
        "re-sync Portal.sol, re-audit the storage mirror in " +
        "PortalStbtcRecovery.sol, and update helpers/recovery-anchors.ts in " +
        "a reviewed commit before re-pinning",
    )
  }

  const portal = new ethers.Contract(
    addresses.portal,
    [
      "function tbtcToken() view returns (address)",
      "function depositCount() view returns (uint256)",
      "function feeInfo(address) view returns (uint96 totalMinted,uint32 lastFeeUpdateAt,uint88 feeIntegral,uint8 annualFee,uint8 mintCap,address receiptToken,uint96 feeCollected)",
      "function deposits(address,address,uint256) view returns (uint96 balance,uint32 unlockAt,uint96 receiptMinted,uint96 feeOwed,uint88 lastFeeIntegral,uint8 tbtcMigrationState,bool autoBridgingOptOut)",
    ],
    ethers.provider,
  )
  const proxyAdminContract = new ethers.Contract(
    proxyAdmin,
    ["function owner() view returns (address)"],
    ethers.provider,
  )

  const tbtcAddress = ethers.getAddress(await portal.tbtcToken(blockTag))
  const fee = await portal.feeInfo(tbtcAddress, blockTag)
  const stbtcAddress = ethers.getAddress(fee.receiptToken)
  const timelockAddress = ethers.getAddress(
    await proxyAdminContract.owner(blockTag),
  )

  const tbtc = new ethers.Contract(
    tbtcAddress,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider,
  )
  const stbtc = new ethers.Contract(
    stbtcAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function currentDebt(address) view returns (uint256)",
    ],
    ethers.provider,
  )

  const recoveryAmount = BigInt(
    await stbtc.balanceOf(addresses.receiptPayer, blockTag),
  )
  if (recoveryAmount === 0n) {
    fail(`receipt payer ${addresses.receiptPayer} holds no stBTC`)
  }

  log(
    `Scanning ReceiptMinted logs from ${scanStart} to ${pinBlock} ` +
      `(chunk ${scanChunk})...`,
  )
  const tbtcTopic = ethers.zeroPadValue(tbtcAddress, 32)
  const candidates = await scanReceiptMintedDeposits(
    addresses.portal,
    tbtcTopic,
    scanStart,
    pinBlock,
    scanChunk,
  )
  log(`Found ${candidates.size} deposits with tBTC receipt mint history`)

  const effectiveFeeIntegral = effectiveFeeIntegralAt(
    {
      feeIntegral: BigInt(fee.feeIntegral),
      lastFeeUpdateAt: BigInt(fee.lastFeeUpdateAt),
      annualFee: BigInt(fee.annualFee),
    },
    BigInt(block.timestamp),
  )

  const candidateList = Array.from(candidates.values())
  const states = await mapWithConcurrency(candidateList, 8, async (entry) => {
    const deposit = await portal.deposits(
      entry.depositor,
      tbtcAddress,
      entry.depositId,
      blockTag,
    )
    return { entry, deposit }
  })

  const active: ActiveDeposit[] = []
  states.forEach(({ entry, deposit }) => {
    const receiptMinted = BigInt(deposit.receiptMinted)
    if (receiptMinted === 0n) {
      return
    }
    const balance = BigInt(deposit.balance)
    const feeOwed = BigInt(deposit.feeOwed)
    const lastFeeIntegral = BigInt(deposit.lastFeeIntegral)
    const projectedFee = projectedFeeOwed(
      { feeOwedWei: feeOwed, lastFeeIntegral, receiptMintedWei: receiptMinted },
      effectiveFeeIntegral,
    )
    active.push({
      depositor: entry.depositor,
      depositId: entry.depositId,
      balance,
      receiptMinted,
      feeOwed,
      lastFeeIntegral,
      migrationState: Number(deposit.tbtcMigrationState),
      projectedFee,
      collateralMargin: balance - receiptMinted - projectedFee,
    })
  })

  const activeDebtTotal = active.reduce(
    (total, deposit) => total + deposit.receiptMinted,
    0n,
  )
  log(
    `Active tBTC debt positions: ${active.length}, ` +
      `total debt ${activeDebtTotal.toString()}`,
  )
  // The Portal's own bookkeeping is the completeness check for the event
  // scan: every wei of tBTC receipt debt was minted through a ReceiptMinted
  // event, so a scan that starts too late or a provider that dropped logs
  // shows up as a shortfall here instead of silently truncating the
  // candidate set and the owners' active-deposit lists.
  if (activeDebtTotal !== BigInt(fee.totalMinted)) {
    fail(
      `scanned active debt ${activeDebtTotal.toString()} does not match the ` +
        `Portal's feeInfo.totalMinted ${fee.totalMinted.toString()}; the ` +
        "ReceiptMinted scan is incomplete — check SCAN_START_BLOCK and the " +
        "RPC provider's log coverage",
    )
  }

  const depositors = Array.from(
    new Set(active.map((deposit) => deposit.depositor)),
  )
  const balanceEntries = await mapWithConcurrency(
    depositors,
    8,
    async (depositor) => ({
      depositor,
      balance: BigInt(await stbtc.balanceOf(depositor, blockTag)),
    }),
  )
  const stbtcBalances = new Map(
    balanceEntries.map(({ depositor, balance }) => [depositor, balance]),
  )
  // Per-depositor repayable debt, EXCLUDING deposits in tBTC migration —
  // the exact semantics of the contract's stranding guard and of
  // recomputeActiveReceiptDebt, which the preflight and fork test use to
  // verify this very field at the snapshot block. The id lists still carry
  // every deposit with receipt debt (migration is re-evaluated dynamically
  // at read time by every consumer).
  const activeDebtByDepositor = new Map<string, bigint>()
  const activeDepositIdsByDepositor = new Map<string, bigint[]>()
  active.forEach((deposit) => {
    if (deposit.migrationState === 0) {
      activeDebtByDepositor.set(
        deposit.depositor,
        (activeDebtByDepositor.get(deposit.depositor) ?? 0n) +
          deposit.receiptMinted,
      )
    }
    const depositIds = activeDepositIdsByDepositor.get(deposit.depositor) ?? []
    depositIds.push(deposit.depositId)
    activeDepositIdsByDepositor.set(deposit.depositor, depositIds)
  })
  activeDepositIdsByDepositor.forEach((depositIds) =>
    depositIds.sort((a, b) => {
      if (a === b) {
        return 0
      }
      return a < b ? -1 : 1
    }),
  )

  const excludedDepositors = new Set(
    depositors.filter((depositor) => stbtcBalances.get(depositor)! > dustWei),
  )
  const strandingExclusions = Array.from(excludedDepositors)
    .map((depositor) => ({
      depositor,
      stbtcBalanceWei: stbtcBalances.get(depositor)!.toString(),
      activeDebtWei: (activeDebtByDepositor.get(depositor) ?? 0n).toString(),
      depositIds: active
        .filter((deposit) => deposit.depositor === depositor)
        .map((deposit) => deposit.depositId)
        .sort((a, b) => {
          if (a === b) {
            return 0
          }
          return a < b ? -1 : 1
        })
        .map((depositId) => depositId.toString()),
    }))
    // Deterministic order regardless of the JS engine's sort: largest active
    // debt first, ties broken by depositor address, and a 0 return for equal
    // elements so identical chain state always emits identical bytes.
    .sort((a, b) => {
      const debtA = BigInt(a.activeDebtWei)
      const debtB = BigInt(b.activeDebtWei)
      if (debtA !== debtB) {
        return debtB > debtA ? 1 : -1
      }
      if (a.depositor === b.depositor) {
        return 0
      }
      return a.depositor.toLowerCase() < b.depositor.toLowerCase() ? -1 : 1
    })

  const eligible = active
    .filter(
      (deposit) =>
        !excludedDepositors.has(deposit.depositor) &&
        deposit.migrationState === 0 &&
        deposit.collateralMargin >= 0n,
    )
    .sort((a, b) => {
      if (a.receiptMinted !== b.receiptMinted) {
        return a.receiptMinted > b.receiptMinted ? -1 : 1
      }
      return a.depositId < b.depositId ? -1 : 1
    })

  // Each owner's settleable capacity mirrors the contract's stranding
  // guard: non-migrating debt minus their own stBTC holdings. Even a
  // dust-level balance must be reserved here, or the generated manifest
  // would violate the per-owner invariant at its own snapshot block and
  // the fork test's stranding assertion would fail while the preflight
  // stayed green.
  const ownerSettleable = new Map<string, bigint>()
  depositors.forEach((depositor) => {
    const debt = activeDebtByDepositor.get(depositor) ?? 0n
    const balance = stbtcBalances.get(depositor)!
    ownerSettleable.set(depositor, debt > balance ? debt - balance : 0n)
  })

  const eligibleByOwner = new Map<string, bigint>()
  eligible.forEach((deposit) => {
    eligibleByOwner.set(
      deposit.depositor,
      (eligibleByOwner.get(deposit.depositor) ?? 0n) + deposit.receiptMinted,
    )
  })
  let drawableTotal = 0n
  eligibleByOwner.forEach((eligibleDebt, depositor) => {
    const capacity = ownerSettleable.get(depositor)!
    drawableTotal += eligibleDebt < capacity ? eligibleDebt : capacity
  })
  if (drawableTotal < recoveryAmount) {
    fail(
      `eligible (non-stranding) debt ${drawableTotal.toString()} cannot ` +
        `cover the recovery amount ${recoveryAmount.toString()}; governance ` +
        "must revisit the dust threshold or the policy",
    )
  }

  const selected: { deposit: ActiveDeposit; amount: bigint }[] = []
  let remaining = recoveryAmount
  eligible.forEach((deposit) => {
    if (remaining === 0n) {
      return
    }
    const capacity = ownerSettleable.get(deposit.depositor)!
    if (capacity === 0n) {
      return
    }
    let amount = deposit.receiptMinted
    if (amount > capacity) {
      amount = capacity
    }
    if (amount > remaining) {
      amount = remaining
    }
    selected.push({ deposit, amount })
    ownerSettleable.set(deposit.depositor, capacity - amount)
    remaining -= amount
  })
  if (remaining !== 0n) {
    fail("selection failed to reach the recovery amount")
  }

  const manifest: RecoveryManifest = {
    chainId: 1,
    snapshotBlock: pinBlock,
    snapshotTimestamp: new Date(Number(block.timestamp) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    selectionPolicy:
      "Largest active tBTC receipt debts first, restricted to depositors " +
      `holding at most ${dustWei.toString()} wei of stBTC, with each ` +
      "owner's total selection additionally capped at their non-migrating " +
      "debt minus their holdings (a depositor still holding stBTC can " +
      "redeem it against their own debt through the normal repayment path " +
      "and must not be left with unredeemable stBTC); the final deposit is " +
      "settled partially. Excluded depositors are listed under " +
      "strandingExclusions.",
    strandingDustWei: dustWei.toString(),
    addresses: {
      portal: addresses.portal,
      originalImplementation,
      proxyAdmin,
      proxyAdminOwnerTimelock: timelockAddress,
      portalLogicOwner: addresses.portalLogicOwner,
      tbtc: tbtcAddress,
      stbtc: stbtcAddress,
      receiptPayer: addresses.receiptPayer,
      collateralRecipient: addresses.collateralRecipient,
    },
    implementationRuntimeHash,
    recoveryAmountWei: recoveryAmount.toString(),
    observedState: {
      receiptPayerStbtcBalanceWei: recoveryAmount.toString(),
      portalTbtcBalanceWei: (
        await tbtc.balanceOf(addresses.portal, blockTag)
      ).toString(),
      portalStbtcDebtWei: (
        await stbtc.currentDebt(addresses.portal, blockTag)
      ).toString(),
      depositCount: (await portal.depositCount(blockTag)).toString(),
      activeTbtcDepositCount: active.length,
      activeTbtcReceiptDebtWei: activeDebtTotal.toString(),
      feeInfo: {
        totalMintedWei: fee.totalMinted.toString(),
        lastFeeUpdateAt: Number(fee.lastFeeUpdateAt),
        feeIntegral: fee.feeIntegral.toString(),
        annualFeePercent: Number(fee.annualFee),
        mintCapPercent: Number(fee.mintCap),
        receiptToken: stbtcAddress,
        feeCollectedWei: fee.feeCollected.toString(),
      },
    },
    strandingExclusions,
    settlements: selected.map(({ deposit, amount }) => ({
      depositor: deposit.depositor,
      depositId: deposit.depositId.toString(),
      depositIdHex: `0x${deposit.depositId.toString(16)}`,
      amountWei: amount.toString(),
      depositorStbtcBalanceWei: stbtcBalances
        .get(deposit.depositor)!
        .toString(),
      depositorActiveDebtWei: activeDebtByDepositor
        .get(deposit.depositor)!
        .toString(),
      depositorActiveDepositIds: activeDepositIdsByDepositor
        .get(deposit.depositor)!
        .map((depositId) => depositId.toString()),
      preState: {
        balanceWei: deposit.balance.toString(),
        receiptDebtWei: deposit.receiptMinted.toString(),
        feeOwedWei: deposit.feeOwed.toString(),
        lastFeeIntegral: deposit.lastFeeIntegral.toString(),
        migrationState: deposit.migrationState,
        feeAtSnapshotWei: deposit.projectedFee.toString(),
        collateralMarginAtSnapshotWei: deposit.collateralMargin.toString(),
      },
    })),
  }

  const outPath =
    process.env.OUT ??
    join(__dirname, "..", "recovery", `mainnet-${pinBlock}.json`)
  await assertPinnedBlockHashUnchanged(
    ethers.provider,
    block.number,
    block.hash,
  )
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)

  log(
    `Selected ${selected.length} settlements ` +
      `(${strandingExclusions.length} depositors excluded for stranding risk)`,
  )
  log(
    "Manifest written; run `npx prettier --write` on it and update " +
      "helpers/recovery-manifest.ts to point at it.",
  )
  // eslint-disable-next-line no-console
  console.log(outPath)
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
