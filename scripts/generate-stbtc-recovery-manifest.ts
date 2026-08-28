import { writeFileSync } from "fs"
import { join } from "path"
import { artifacts, ethers } from "hardhat"
import { recoveryManifest as currentManifest } from "../helpers/recovery-manifest"

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

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
const ONE_YEAR = 365n * 24n * 60n * 60n
const FEE_PRECISION = 10n ** 18n

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
  const pinBlock = process.env.MANIFEST_BLOCK
    ? Number(process.env.MANIFEST_BLOCK)
    : head - 5
  const scanStart = process.env.SCAN_START_BLOCK
    ? Number(process.env.SCAN_START_BLOCK)
    : 19000000
  const scanChunk = process.env.SCAN_CHUNK
    ? Number(process.env.SCAN_CHUNK)
    : 50000
  const dustWei = BigInt(process.env.STRANDING_DUST_WEI ?? "1000000000000")

  const block = await ethers.provider.getBlock(pinBlock)
  if (!block) {
    fail(`block ${pinBlock} not found`)
  }
  const blockTag = { blockTag: pinBlock }

  const addresses = {
    portal: ethers.getAddress(currentManifest.addresses.portal),
    portalLogicOwner: ethers.getAddress(
      currentManifest.addresses.portalLogicOwner,
    ),
    receiptPayer: ethers.getAddress(currentManifest.addresses.receiptPayer),
    collateralRecipient: ethers.getAddress(
      currentManifest.addresses.collateralRecipient,
    ),
  }

  log(`Pinning manifest at block ${pinBlock} (${block.timestamp})`)

  const originalImplementation = ethers.getAddress(
    `0x${(
      await ethers.provider.send("eth_getStorageAt", [
        addresses.portal,
        IMPLEMENTATION_SLOT,
        ethers.toQuantity(pinBlock),
      ])
    ).slice(-40)}`,
  )
  const proxyAdmin = ethers.getAddress(
    `0x${(
      await ethers.provider.send("eth_getStorageAt", [
        addresses.portal,
        ADMIN_SLOT,
        ethers.toQuantity(pinBlock),
      ])
    ).slice(-40)}`,
  )

  const implementationCode = await ethers.provider.getCode(
    originalImplementation,
    pinBlock,
  )
  const implementationRuntimeHash = ethers.keccak256(implementationCode)
  const portalArtifact = await artifacts.readArtifact("Portal")
  const compiledHash = ethers.keccak256(portalArtifact.deployedBytecode)
  if (compiledHash !== implementationRuntimeHash) {
    log(
      `WARNING: compiled Portal runtime hash ${compiledHash} does not match ` +
        `the live implementation ${implementationRuntimeHash}; the source ` +
        "reconstruction no longer matches the deployed Portal",
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

  const annualFeeRate = (BigInt(fee.annualFee) * 10n ** 16n) / ONE_YEAR
  const effectiveFeeIntegral =
    BigInt(fee.feeIntegral) +
    (BigInt(block.timestamp) - BigInt(fee.lastFeeUpdateAt)) * annualFeeRate

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
    const projectedFee =
      feeOwed +
      ((effectiveFeeIntegral - lastFeeIntegral) * receiptMinted) / FEE_PRECISION
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
  const activeDebtByDepositor = new Map<string, bigint>()
  const activeDepositIdsByDepositor = new Map<string, bigint[]>()
  active.forEach((deposit) => {
    activeDebtByDepositor.set(
      deposit.depositor,
      (activeDebtByDepositor.get(deposit.depositor) ?? 0n) +
        deposit.receiptMinted,
    )
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
      activeDebtWei: activeDebtByDepositor.get(depositor)!.toString(),
      depositIds: active
        .filter((deposit) => deposit.depositor === depositor)
        .map((deposit) => deposit.depositId.toString()),
    }))
    .sort((a, b) =>
      BigInt(b.activeDebtWei) > BigInt(a.activeDebtWei) ? 1 : -1,
    )

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

  const eligibleTotal = eligible.reduce(
    (total, deposit) => total + deposit.receiptMinted,
    0n,
  )
  if (eligibleTotal < recoveryAmount) {
    fail(
      `eligible (non-stranding) debt ${eligibleTotal.toString()} cannot ` +
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
    const amount =
      deposit.receiptMinted <= remaining ? deposit.receiptMinted : remaining
    selected.push({ deposit, amount })
    remaining -= amount
  })
  if (remaining !== 0n) {
    fail("selection failed to reach the recovery amount")
  }

  const manifest = {
    chainId: 1,
    snapshotBlock: pinBlock,
    snapshotTimestamp: new Date(Number(block.timestamp) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    selectionPolicy:
      "Largest active tBTC receipt debts first, restricted to depositors " +
      `holding at most ${dustWei.toString()} wei of stBTC (a depositor still ` +
      "holding stBTC can redeem it against their own debt through the " +
      "normal repayment path and must not be left with unredeemable stBTC); " +
      "the final deposit is settled partially. Excluded depositors are " +
      "listed under strandingExclusions.",
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
