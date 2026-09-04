import {
  BlockTag,
  Contract,
  Filter,
  Interface,
  Log,
  Provider,
  TransactionReceipt,
  getAddress,
  id,
  keccak256,
  solidityPackedKeccak256,
  zeroPadValue,
} from "ethers"
import * as anchors from "./recovery-anchors"

const TRANSFER_TOPIC = id("Transfer(address,address,uint256)")
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const INITIAL_LOG_CHUNK = 500_000
const MINIMUM_LOG_CHUNK = 1_000
const UNISWAP_V3_MINT_TOPIC = id(
  "Mint(address,address,int24,int24,uint128,uint256,uint256)",
)
const UNISWAP_V3_POOL_CREATED_TOPIC = id(
  "PoolCreated(address,address,uint24,int24,address)",
)
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]
const CURVE_ROUTER_ABI = ["function version() view returns (string)"]
const UNISWAP_V3_FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]
const UNISWAP_V3_POOL_ABI = [
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function positions(bytes32 key) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
]
const UNISWAP_V3_POSITION_MANAGER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)",
]

// This exact, deliberately explicit value is an operator attestation, not an
// automated proof. It must be supplied only after the screened depositors'
// other controlled addresses and LP/share/gauge/vault positions have been
// checked immediately before execution.
export const EXTERNAL_STBTC_REVIEW_CONFIRMATION =
  "I_CONFIRM_NO_EXTERNAL_STBTC_CLAIMS"

export type ExternalStbtcTransfer = {
  destination: string
  amountWei: bigint
  transactionHash?: string
  blockNumber?: number
  blockHash?: string
  logIndex?: number
}

export type ExternalStbtcDestinationResolution = {
  adapter: "portal-sink" | "curve-router-v1.1" | "uniswap-v3-pool"
  status: "noClaim" | "claim" | "unresolved"
  evidence: string
}

export type ExternalStbtcNftPositionReport = {
  adapter: "uniswap-v3-nft"
  tokenId: bigint
  owner: string
  token0: string
  token1: string
  fee: number
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

export type ExternalStbtcCorePositionReport = {
  adapter: "uniswap-v3-core"
  pool: string
  token0: string
  token1: string
  fee: number
  owner: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

export type ExternalStbtcPositionReport =
  ExternalStbtcNftPositionReport | ExternalStbtcCorePositionReport

export type ExternalStbtcReader = {
  getSentTransfers(depositor: string): Promise<ExternalStbtcTransfer[]>
  getTotalReceivedWei(depositor: string): Promise<bigint>
  getStbtcBalance(address: string): Promise<bigint>
  getCode(address: string): Promise<string>
  getTokenBalance(token: string, holder: string): Promise<bigint>
  getTokenSymbol(token: string): Promise<string>
  resolveKnownDestination(
    depositor: string,
    destination: string,
    transfers: ExternalStbtcTransfer[],
  ): Promise<ExternalStbtcDestinationResolution | undefined>
  getUniswapV3Positions(
    depositor: string,
  ): Promise<ExternalStbtcPositionReport[]>
}

export type ExternalStbtcDestinationReport = {
  destination: string
  amountSentWei: bigint
  isContract: boolean
  venueStbtcBalanceWei?: bigint
  depositorClaimBalanceWei?: bigint
  symbol?: string
  claimBalanceError?: string
  adapter?: ExternalStbtcDestinationResolution["adapter"]
  resolution?: ExternalStbtcDestinationResolution["status"]
  protocolEvidence?: string
}

export type ExternalStbtcDepositorReport = {
  depositor: string
  totalReceivedWei: bigint
  totalSentWei: bigint
  walletBalanceWei: bigint
  destinations: ExternalStbtcDestinationReport[]
  positions: ExternalStbtcPositionReport[]
}

export type ExternalStbtcScreenReport = {
  depositors: ExternalStbtcDepositorReport[]
  detectedClaimReasons: string[]
  unverifiableReasons: string[]
  limitation: string
}

export type ExternalStbtcGate = {
  passed: boolean
  manualReviewConfirmed: boolean
  blockingReasons: string[]
  report: ExternalStbtcScreenReport
}

type ExternalStbtcLogHistoryEntry = {
  filterFingerprint: string
  fromBlock: number
  throughBlock: number
  logs: Log[]
}

// An execute-stage scan keeps raw logs rather than a summarized report: later
// heads must still be able to reconstruct transfer provenance, NFT ownership,
// and every directly minted Uniswap range. Entries are advanced only across
// the missing numeric tail and remain bound to the reviewed token pair and
// deployment boundary for the lifetime of one preflight process.
export type ExternalStbtcLogHistory = {
  tbtcAddress: string
  stbtcAddress: string
  fromBlock: number
  entries: Map<string, ExternalStbtcLogHistoryEntry>
}

export function createExternalStbtcLogHistory(
  tbtcAddress: string,
  stbtcAddress: string,
  fromBlock = anchors.STBTC_DEPLOYMENT_BLOCK,
): ExternalStbtcLogHistory {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw new Error(`invalid stBTC history start block ${fromBlock.toString()}`)
  }
  return {
    tbtcAddress: getAddress(tbtcAddress),
    stbtcAddress: getAddress(stbtcAddress),
    fromBlock,
    entries: new Map(),
  }
}

function historyFilterFingerprint(filter: Filter): string {
  const normalize = (value: unknown): unknown => {
    if (value === undefined || value === null) {
      return value ?? null
    }
    if (Array.isArray(value)) {
      return value.map(normalize)
    }
    if (typeof value === "string") {
      return value.toLowerCase()
    }
    throw new Error("unsupported archive-log filter in stBTC history cache")
  }
  return JSON.stringify({
    address: normalize(filter.address),
    topics: normalize(filter.topics),
  })
}

export async function extendExternalStbtcLogHistory(
  provider: Pick<Provider, "getLogs">,
  history: ExternalStbtcLogHistory,
  cacheKey: string,
  filter: Filter,
  throughBlock: number,
  fromBlock = history.fromBlock,
): Promise<Log[]> {
  if (!cacheKey) {
    throw new Error("stBTC history cache key must not be empty")
  }
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw new Error(`invalid stBTC history start block ${fromBlock.toString()}`)
  }
  if (!Number.isSafeInteger(throughBlock) || throughBlock < fromBlock) {
    throw new Error(`invalid stBTC history endpoint ${throughBlock.toString()}`)
  }

  const fingerprint = historyFilterFingerprint(filter)
  const existing = history.entries.get(cacheKey)
  if (existing && existing.filterFingerprint !== fingerprint) {
    throw new Error(`stBTC history cache key ${cacheKey} changed filters`)
  }
  if (existing && existing.fromBlock !== fromBlock) {
    throw new Error(`stBTC history cache key ${cacheKey} changed start block`)
  }
  if (existing && throughBlock < existing.throughBlock) {
    throw new Error(
      `stBTC history cache cannot move ${cacheKey} backward from ` +
        `${existing.throughBlock.toString()} to ${throughBlock.toString()}`,
    )
  }
  if (existing && throughBlock === existing.throughBlock) {
    return [...existing.logs]
  }

  const nextBlock = existing ? existing.throughBlock + 1 : fromBlock
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  const tail = await getLogsInChunks(provider, filter, nextBlock, throughBlock)
  tail.forEach((log) => {
    if (log.blockNumber < nextBlock || log.blockNumber > throughBlock) {
      throw new Error(
        `archive RPC returned log ${log.transactionHash}:${log.index} ` +
          `outside requested range ${nextBlock.toString()}-${throughBlock.toString()}`,
      )
    }
    if (log.removed) {
      throw new Error(
        `archive RPC returned removed log ${log.transactionHash}:${log.index}`,
      )
    }
  })

  const logs = existing ? [...existing.logs, ...tail] : [...tail]
  history.entries.set(cacheKey, {
    filterFingerprint: fingerprint,
    fromBlock,
    throughBlock,
    logs,
  })
  return [...logs]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`
}

// Archive providers impose different eth_getLogs range caps. Query bounded,
// inclusive ranges and adapt downward on rejection while preserving exact
// chronological coverage. Errors at the minimum range remain fatal so the
// execution gate can never mistake incomplete history for an empty result.
export async function getLogsInChunks(
  provider: Pick<Provider, "getLogs">,
  filter: Filter,
  fromBlock: number,
  toBlock: number,
  initialChunk = INITIAL_LOG_CHUNK,
  minimumChunk = MINIMUM_LOG_CHUNK,
): Promise<Log[]> {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock ||
    !Number.isSafeInteger(initialChunk) ||
    !Number.isSafeInteger(minimumChunk) ||
    minimumChunk <= 0 ||
    initialChunk < minimumChunk
  ) {
    throw new Error("invalid archive log range or chunk size")
  }

  const logs: Log[] = []
  let start = fromBlock
  let chunk = initialChunk
  while (start <= toBlock) {
    const end = Math.min(start + chunk - 1, toBlock)
    try {
      // eslint-disable-next-line no-await-in-loop
      const page = await provider.getLogs({
        ...filter,
        fromBlock: start,
        toBlock: end,
      })
      logs.push(...page)
      start = end + 1
      if (chunk < initialChunk) {
        chunk = Math.min(initialChunk, chunk * 2)
      }
    } catch (error) {
      if (chunk === minimumChunk) {
        throw error
      }
      chunk = Math.max(minimumChunk, Math.floor(chunk / 2))
    }
  }
  return logs
}

// Automates only what chain history can establish without knowing which
// other accounts and protocols a depositor controls. A clear report is
// intentionally not sufficient to pass evaluateExternalStbtcGate(): LP
// tokens can arrive without a direct stBTC transfer, can be staked in a
// gauge/vault, and stBTC can sit at an undisclosed related address.
export async function screenExternalStbtcHoldings(
  depositors: string[],
  reader: ExternalStbtcReader,
): Promise<ExternalStbtcScreenReport> {
  const reports: ExternalStbtcDepositorReport[] = []
  const detectedClaimReasons: string[] = []
  const unverifiableReasons: string[] = []

  // Sequential on purpose: the production reader performs archive-log
  // queries, and unbounded parallel ranges are routinely rate limited.
  /* eslint-disable no-await-in-loop */
  // eslint-disable-next-line no-restricted-syntax
  for (const rawDepositor of depositors) {
    const depositor = getAddress(rawDepositor)
    const depositorReads = Promise.all([
      reader.getSentTransfers(depositor),
      reader.getTotalReceivedWei(depositor),
      reader.getStbtcBalance(depositor),
    ])
    const [sentTransfers, totalReceivedWei, walletBalanceWei] =
      await depositorReads
    // Standard ERC-20 transferFrom permits an unapproved caller to emit a
    // zero-value Transfer from this depositor. Such a log moves no stBTC and
    // creates no claim, so it must not introduce a destination whose
    // balanceOf behavior can veto the mandatory screen.
    const nonzeroSentTransfers = sentTransfers.filter(
      ({ amountWei }) => amountWei !== 0n,
    )
    const totalSentWei = nonzeroSentTransfers.reduce(
      (total, transfer) => total + transfer.amountWei,
      0n,
    )
    const historyBalanceWei = totalReceivedWei - totalSentWei
    if (historyBalanceWei !== walletBalanceWei) {
      unverifiableReasons.push(
        `${depositor}'s stBTC Transfer history does not reconcile: received ` +
          `${totalReceivedWei.toString()} - sent ${totalSentWei.toString()} = ` +
          `${historyBalanceWei.toString()}, but pinned balanceOf is ` +
          `${walletBalanceWei.toString()}`,
      )
    }

    const amountsByDestination = new Map<string, bigint>()
    nonzeroSentTransfers.forEach(({ destination, amountWei }) => {
      const normalized = getAddress(destination)
      amountsByDestination.set(
        normalized,
        (amountsByDestination.get(normalized) ?? 0n) + amountWei,
      )
    })

    const destinations: ExternalStbtcDestinationReport[] = []
    // eslint-disable-next-line no-restricted-syntax
    for (const [destination, amountSentWei] of amountsByDestination) {
      const isContract = (await reader.getCode(destination)) !== "0x"
      const destinationReport: ExternalStbtcDestinationReport = {
        destination,
        amountSentWei,
        isContract,
      }

      const transfers = nonzeroSentTransfers.filter(
        (transfer) =>
          getAddress(transfer.destination) === getAddress(destination),
      )
      let knownResolution: ExternalStbtcDestinationResolution | undefined
      let resolutionFailed = false
      try {
        // Resolve reviewed addresses even if their code disappeared. Code
        // absence/drift must become UNRESOLVED, not silently reclassify a
        // previously reviewed protocol as an EOA.
        knownResolution = await reader.resolveKnownDestination(
          depositor,
          destination,
          transfers,
        )
      } catch (error) {
        resolutionFailed = true
        const detail = errorMessage(error)
        destinationReport.claimBalanceError = detail
        unverifiableReasons.push(
          `cannot classify ${depositor}'s interaction with ` +
            `${destination}: ${detail}`,
        )
      }

      if (knownResolution) {
        destinationReport.venueStbtcBalanceWei =
          await reader.getStbtcBalance(destination)
        destinationReport.adapter = knownResolution.adapter
        destinationReport.resolution = knownResolution.status
        destinationReport.protocolEvidence = knownResolution.evidence
        if (knownResolution.status === "claim") {
          detectedClaimReasons.push(
            `${depositor} has an external stBTC claim through ` +
              `${destination}: ${knownResolution.evidence}`,
          )
        } else if (knownResolution.status === "unresolved") {
          unverifiableReasons.push(
            `cannot resolve ${depositor}'s interaction with ` +
              `${destination}: ${knownResolution.evidence}`,
          )
        }
      } else if (isContract && !resolutionFailed) {
        const venueStbtcBalanceWei = await reader.getStbtcBalance(destination)
        destinationReport.venueStbtcBalanceWei = venueStbtcBalanceWei
        try {
          // A share token can deploy all underlying into a strategy and hold
          // zero stBTC itself. Query every unknown contract destination;
          // current venue custody is context, never a prerequisite.
          const claimBalanceWei = await reader.getTokenBalance(
            destination,
            depositor,
          )
          destinationReport.depositorClaimBalanceWei = claimBalanceWei

          if (claimBalanceWei > 0n) {
            try {
              destinationReport.symbol =
                await reader.getTokenSymbol(destination)
            } catch {
              // Non-standard, bytes32, and reverting symbol() methods are
              // display-only failures. The claim remains blocking and is
              // identified by its contract address.
            }
            detectedClaimReasons.push(
              `${depositor} holds ${claimBalanceWei.toString()} share/LP ` +
                `units in external venue ${destination}`,
            )
          }
        } catch (error) {
          const detail = errorMessage(error)
          destinationReport.claimBalanceError = detail
          unverifiableReasons.push(
            `cannot evaluate ${depositor}'s share/LP balance in ` +
              `external venue ${destination}: ${detail}`,
          )
        }
      }
      destinations.push(destinationReport)
    }

    let positions: ExternalStbtcPositionReport[] = []
    try {
      positions = await reader.getUniswapV3Positions(depositor)
      positions.forEach((position) => {
        if (
          position.liquidity > 0n ||
          position.tokensOwed0 > 0n ||
          position.tokensOwed1 > 0n
        ) {
          const positionId =
            position.adapter === "uniswap-v3-nft"
              ? `NFT ${position.tokenId.toString()}`
              : `core range ${position.tickLower}/${position.tickUpper} ` +
                `in pool ${position.pool}`
          detectedClaimReasons.push(
            `${depositor} owns Uniswap V3 ${positionId} ` +
              `with liquidity ${position.liquidity.toString()} and owed ` +
              `${position.tokensOwed0.toString()}/${position.tokensOwed1.toString()}`,
          )
        }
      })
    } catch (error) {
      unverifiableReasons.push(
        `cannot enumerate ${depositor}'s canonical Uniswap V3 stBTC ` +
          `positions: ${errorMessage(error)}`,
      )
    }

    reports.push({
      depositor,
      totalReceivedWei,
      totalSentWei,
      walletBalanceWei,
      destinations,
      positions,
    })
  }
  /* eslint-enable no-await-in-loop */

  return {
    depositors: reports,
    detectedClaimReasons,
    unverifiableReasons,
    limitation:
      "transfer destinations are not exhaustive: manually verify LP/share " +
      "tokens received from third parties, staked gauge/vault positions, " +
      "and every other address controlled by each screened depositor",
  }
}

export function evaluateExternalStbtcGate(
  report: ExternalStbtcScreenReport,
  confirmation: string | undefined,
): ExternalStbtcGate {
  const manualReviewConfirmed =
    confirmation === EXTERNAL_STBTC_REVIEW_CONFIRMATION
  // Concrete nonzero claims and unreadable relevant balances always block.
  // The manual attestation covers only positions/address ownership the
  // automated scan cannot enumerate; it must not override a failed RPC or
  // balanceOf call that could be concealing a claim.
  const blockingReasons = [
    ...report.detectedClaimReasons,
    ...report.unverifiableReasons,
  ]
  if (!manualReviewConfirmed) {
    blockingReasons.push(
      "manual external-holdings verification is missing; set " +
        `RECOVERY_EXTERNAL_STBTC_REVIEW=${EXTERNAL_STBTC_REVIEW_CONFIRMATION} ` +
        "only after checking every screened depositor's other controlled " +
        "addresses and LP/share/gauge/vault positions",
    )
  }

  return {
    passed: blockingReasons.length === 0,
    manualReviewConfirmed,
    blockingReasons,
    report,
  }
}

function paddedAddress(address: string): string {
  return zeroPadValue(getAddress(address), 32)
}

function addressFromTopic(topic: string): string {
  return getAddress(`0x${topic.slice(-40)}`)
}

function canonicalAddress(value: string): string {
  return getAddress(value)
}

function signedInt24(topic: string): number {
  return Number(BigInt.asIntN(24, BigInt(topic)))
}

function sameAddress(left: string, right: string): boolean {
  return canonicalAddress(left) === canonicalAddress(right)
}

function requireRuntimeHash(
  label: string,
  code: string,
  expectedHash: string,
): void {
  const actualHash = keccak256(code)
  if (actualHash !== expectedHash) {
    throw new Error(
      `${label} runtime hash ${actualHash} does not match reviewed ` +
        `${expectedHash}`,
    )
  }
}

function addressFromStorageWord(word: string): string {
  return canonicalAddress(`0x${word.slice(-40)}`)
}

export type UniswapV3PoolIdentity = {
  factory: string
  token0: string
  token1: string
  fee: number
}

export type UniswapV3CorePositionState = {
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

// Pinned-block primitives behind the direct core-position scan, separated
// from the ethers wiring so the classification rules can be tested without
// an archive RPC.
export type UniswapV3CoreReader = {
  // Every `Mint` log whose indexed owner is the depositor, from ANY emitting
  // contract, over the complete stBTC history range.
  getDirectMintLogs(owner: string): Promise<Log[]>
  // Complete canonical-factory PoolCreated history for stBTC in either
  // token slot, including pools created before the token was deployed.
  getStbtcPoolCreationLogs(): Promise<Log[]>
  // factory()/token0()/token1()/fee() of an emitting contract; must throw
  // when the emitter does not answer like a Uniswap V3 pool.
  getPoolIdentity(pool: string): Promise<UniswapV3PoolIdentity>
  // Canonical factory registration for a pair and fee tier.
  getRegisteredPool(
    token0: string,
    token1: string,
    fee: number,
  ): Promise<string>
  getCorePosition(
    pool: string,
    key: string,
  ): Promise<UniswapV3CorePositionState>
}

// Uniswap V3 core lets any contract mint a position to an arbitrary owner
// without the canonical NFT manager, and the owner is indexed in every pool's
// Mint event. Enumerate every range ever minted to the depositor in ANY pool
// (an address-less log query), authenticate emitters against the canonical
// factory's stBTC PoolCreated history, and re-read the live position key for
// every authenticated range. Restricting the query to the anchored tBTC/stBTC pool
// would miss a range in any other stBTC pool — including one somebody else
// funded, which the depositor's own stBTC transfer history cannot discover
// either. Unauthenticated event data establishes no claim and is ignored by
// this adapter; transfer-destination and manual review cover other venues.
// Failed reads for authenticated stBTC pools remain blocking.
export async function enumerateDirectCorePositions(
  depositor: string,
  stbtcAddress: string,
  reader: UniswapV3CoreReader,
): Promise<ExternalStbtcCorePositionReport[]> {
  const owner = canonicalAddress(depositor)
  const [mintLogs, creationLogs] = await Promise.all([
    reader.getDirectMintLogs(owner),
    reader.getStbtcPoolCreationLogs(),
  ])
  const factoryInterface = new Interface(UNISWAP_V3_FACTORY_ABI)
  const canonicalPools = new Map<string, UniswapV3PoolIdentity>()
  creationLogs.forEach((log) => {
    if (!sameAddress(log.address, anchors.UNISWAP_V3_FACTORY)) {
      throw new Error("PoolCreated history contains a non-canonical factory")
    }
    const creation = factoryInterface.parseLog(log)
    if (!creation || creation.name !== "PoolCreated") {
      throw new Error("malformed canonical Uniswap V3 PoolCreated log")
    }
    const token0 = canonicalAddress(creation.args.token0)
    const token1 = canonicalAddress(creation.args.token1)
    if (
      sameAddress(token0, stbtcAddress) ||
      sameAddress(token1, stbtcAddress)
    ) {
      canonicalPools.set(canonicalAddress(creation.args.pool), {
        factory: anchors.UNISWAP_V3_FACTORY,
        token0,
        token1,
        fee: Number(creation.args.fee),
      })
    }
  })
  const rangesByPool = new Map<
    string,
    Map<string, { tickLower: number; tickUpper: number }>
  >()
  mintLogs.forEach((log) => {
    const pool = canonicalAddress(log.address)
    if (!canonicalPools.has(pool)) {
      return
    }
    const logId = `${log.transactionHash}:${log.index}`
    if (log.topics.length < 4 || log.topics[0] !== UNISWAP_V3_MINT_TOPIC) {
      throw new Error(`malformed Uniswap V3 Mint log ${logId}`)
    }
    if (!sameAddress(addressFromTopic(log.topics[1]), owner)) {
      throw new Error(
        `Uniswap V3 Mint log ${logId} is not credited to ${owner}`,
      )
    }
    const tickLower = signedInt24(log.topics[2])
    const tickUpper = signedInt24(log.topics[3])
    const ranges =
      rangesByPool.get(pool) ??
      new Map<string, { tickLower: number; tickUpper: number }>()
    ranges.set(`${tickLower}:${tickUpper}`, { tickLower, tickUpper })
    rangesByPool.set(pool, ranges)
  })

  const reports: ExternalStbtcCorePositionReport[] = []
  const pools = Array.from(rangesByPool.entries()).sort(([left], [right]) => {
    if (left === right) {
      return 0
    }
    return left < right ? -1 : 1
  })
  // Sequential and sorted: deterministic report order and bounded fan-out
  // against rate-limited archive providers.
  /* eslint-disable no-await-in-loop */
  // eslint-disable-next-line no-restricted-syntax
  for (const [pool, ranges] of pools) {
    let identity: UniswapV3PoolIdentity
    try {
      identity = await reader.getPoolIdentity(pool)
    } catch (error) {
      throw new Error(
        `Uniswap V3 Mint emitter ${pool} credited ${owner} with a direct ` +
          `position but cannot be classified as a pool: ${errorMessage(error)}`,
      )
    }
    const token0 = canonicalAddress(identity.token0)
    const token1 = canonicalAddress(identity.token1)
    const creation = canonicalPools.get(pool)
    if (
      !creation ||
      token0 !== creation.token0 ||
      token1 !== creation.token1 ||
      identity.fee !== creation.fee
    ) {
      throw new Error(`stBTC pool ${pool} identity disagrees with PoolCreated`)
    }
    if (!sameAddress(identity.factory, anchors.UNISWAP_V3_FACTORY)) {
      throw new Error(
        `stBTC pool ${pool} holding a direct position for ${owner} ` +
          `reports non-canonical factory ${identity.factory}`,
      )
    }
    const registeredPool = await reader.getRegisteredPool(
      token0,
      token1,
      identity.fee,
    )
    if (!sameAddress(registeredPool, pool)) {
      throw new Error(
        `stBTC pool ${pool} holding a direct position for ${owner} is ` +
          `not the canonical factory's ${token0}/${token1}/${identity.fee} ` +
          `pool (${registeredPool})`,
      )
    }
    // eslint-disable-next-line no-restricted-syntax
    for (const { tickLower, tickUpper } of ranges.values()) {
      const key = solidityPackedKeccak256(
        ["address", "int24", "int24"],
        [owner, tickLower, tickUpper],
      )
      const position = await reader.getCorePosition(pool, key)
      reports.push({
        adapter: "uniswap-v3-core",
        pool,
        token0,
        token1,
        fee: identity.fee,
        owner,
        tickLower,
        tickUpper,
        liquidity: position.liquidity,
        tokensOwed0: position.tokensOwed0,
        tokensOwed1: position.tokensOwed1,
      })
    }
  }
  /* eslint-enable no-await-in-loop */
  return reports
}

// The Portal is an intentional terminal sink for stBTC: repayReceipt pulls
// tokens here and burns them, while an unsolicited direct transfer creates
// no depositor-owned share or withdrawal claim. Exempt it from the unknown
// ERC-20-share probe only while the proxy still points to the exact reviewed
// implementation whose behavior the recovery is built against.
export async function verifyPortalSinkIdentity(
  provider: Pick<Provider, "getCode" | "getStorage">,
  blockTag: BlockTag,
): Promise<string> {
  const [proxyCode, implementationWord] = await Promise.all([
    provider.getCode(anchors.PORTAL, blockTag),
    provider.getStorage(anchors.PORTAL, IMPLEMENTATION_SLOT, blockTag),
  ])
  if (proxyCode === "0x") {
    throw new Error("Portal proxy has no code at the pinned block")
  }
  const implementation = addressFromStorageWord(implementationWord)
  if (!sameAddress(implementation, anchors.ORIGINAL_IMPLEMENTATION)) {
    throw new Error(
      `Portal implementation ${implementation} does not match reviewed ${
        anchors.ORIGINAL_IMPLEMENTATION
      }`,
    )
  }
  const implementationCode = await provider.getCode(implementation, blockTag)
  requireRuntimeHash(
    "Portal implementation",
    implementationCode,
    anchors.IMPLEMENTATION_RUNTIME_HASH,
  )
  return implementation
}

function transferMatches(
  log: Log,
  token: string,
  from: string,
  to: string,
  amountWei?: bigint,
): boolean {
  if (
    !sameAddress(log.address, token) ||
    log.topics[0] !== TRANSFER_TOPIC ||
    log.topics.length < 3 ||
    !sameAddress(addressFromTopic(log.topics[1]), from) ||
    !sameAddress(addressFromTopic(log.topics[2]), to)
  ) {
    return false
  }
  return amountWei === undefined || BigInt(log.data) === amountWei
}

function receiptLogs(receipt: TransactionReceipt): Log[] {
  return receipt.logs.filter((log): log is Log => log instanceof Log)
}

export function createEthersExternalStbtcReader(
  provider: Provider,
  tbtcAddress: string,
  stbtcAddress: string,
  blockNumber: number,
  blockHash: string | null,
  history?: ExternalStbtcLogHistory,
): ExternalStbtcReader {
  if (blockHash === null) {
    throw new Error(`pinned block ${blockNumber} has no hash`)
  }
  if (
    history &&
    (history.tbtcAddress !== getAddress(tbtcAddress) ||
      history.stbtcAddress !== getAddress(stbtcAddress) ||
      history.fromBlock !== anchors.STBTC_DEPLOYMENT_BLOCK)
  ) {
    throw new Error(
      "stBTC history cache is bound to a different token pair or deployment boundary",
    )
  }
  const stbtc = new Contract(stbtcAddress, ERC20_ABI, provider)
  const callOverrides = { blockTag: blockHash }
  const curveRouter = new Contract(
    anchors.CURVE_ROUTER_V1_1,
    CURVE_ROUTER_ABI,
    provider,
  )
  const uniswapFactory = new Contract(
    anchors.UNISWAP_V3_FACTORY,
    UNISWAP_V3_FACTORY_ABI,
    provider,
  )
  const uniswapPool = new Contract(
    anchors.UNISWAP_V3_TBTC_STBTC_POOL,
    UNISWAP_V3_POOL_ABI,
    provider,
  )
  const positionManager = new Contract(
    anchors.UNISWAP_V3_POSITION_MANAGER,
    UNISWAP_V3_POSITION_MANAGER_ABI,
    provider,
  )

  let historyBoundaryCheck: Promise<void> | undefined
  const verifyHistoryBoundary = (): Promise<void> => {
    if (!historyBoundaryCheck) {
      historyBoundaryCheck = (async () => {
        if (blockNumber < anchors.STBTC_DEPLOYMENT_BLOCK) {
          throw new Error(
            `pinned block ${blockNumber} predates stBTC deployment block ${anchors.STBTC_DEPLOYMENT_BLOCK.toString()}`,
          )
        }
        const [beforeCode, deploymentCode] = await Promise.all([
          provider.getCode(stbtcAddress, anchors.STBTC_DEPLOYMENT_BLOCK - 1),
          provider.getCode(stbtcAddress, anchors.STBTC_DEPLOYMENT_BLOCK),
        ])
        if (beforeCode !== "0x" || deploymentCode === "0x") {
          throw new Error(
            `stBTC code does not match reviewed deployment boundary ${anchors.STBTC_DEPLOYMENT_BLOCK.toString()}`,
          )
        }
      })()
    }
    return historyBoundaryCheck
  }
  const getHistoricalLogs = async (
    cacheKey: string,
    filter: Filter,
    fromBlock = anchors.STBTC_DEPLOYMENT_BLOCK,
  ): Promise<Log[]> => {
    await verifyHistoryBoundary()
    if (history) {
      return extendExternalStbtcLogHistory(
        provider,
        history,
        cacheKey,
        filter,
        blockNumber,
        fromBlock,
      )
    }
    return getLogsInChunks(provider, filter, fromBlock, blockNumber)
  }

  // Factory discovery starts at genesis: a pool can be created before
  // stBTC itself has code. Share the result across owners at this hash and
  // retain its raw logs across convergence passes using a distinct cache key.
  let poolCreationLogs: Promise<Log[]> | undefined
  const getStbtcPoolCreationLogs = (): Promise<Log[]> => {
    if (!poolCreationLogs) {
      poolCreationLogs = (async () => {
        const token0Logs = await getHistoricalLogs(
          "uniswap-stbtc-pools:token0",
          {
            address: anchors.UNISWAP_V3_FACTORY,
            topics: [
              UNISWAP_V3_POOL_CREATED_TOPIC,
              paddedAddress(stbtcAddress),
            ],
          },
          0,
        )
        const token1Logs = await getHistoricalLogs(
          "uniswap-stbtc-pools:token1",
          {
            address: anchors.UNISWAP_V3_FACTORY,
            topics: [
              UNISWAP_V3_POOL_CREATED_TOPIC,
              null,
              paddedAddress(stbtcAddress),
            ],
          },
          0,
        )
        return [...token0Logs, ...token1Logs]
      })()
    }
    return poolCreationLogs
  }

  let protocolIdentityCheck: Promise<void> | undefined
  const verifyProtocolIdentities = (): Promise<void> => {
    if (!protocolIdentityCheck) {
      protocolIdentityCheck = (async () => {
        const [curveCode, factoryCode, poolCode, positionManagerCode] =
          await Promise.all([
            provider.getCode(anchors.CURVE_ROUTER_V1_1, blockHash),
            provider.getCode(anchors.UNISWAP_V3_FACTORY, blockHash),
            provider.getCode(anchors.UNISWAP_V3_TBTC_STBTC_POOL, blockHash),
            provider.getCode(anchors.UNISWAP_V3_POSITION_MANAGER, blockHash),
          ])
        requireRuntimeHash(
          "Curve router v1.1",
          curveCode,
          anchors.CURVE_ROUTER_V1_1_RUNTIME_HASH,
        )
        requireRuntimeHash(
          "Uniswap V3 factory",
          factoryCode,
          anchors.UNISWAP_V3_FACTORY_RUNTIME_HASH,
        )
        requireRuntimeHash(
          "Uniswap V3 tBTC/stBTC pool",
          poolCode,
          anchors.UNISWAP_V3_TBTC_STBTC_POOL_RUNTIME_HASH,
        )
        requireRuntimeHash(
          "Uniswap V3 position manager",
          positionManagerCode,
          anchors.UNISWAP_V3_POSITION_MANAGER_RUNTIME_HASH,
        )
      })()
    }
    return protocolIdentityCheck
  }

  const verifyCurveTransfer = async (
    depositor: string,
    transfer: ExternalStbtcTransfer,
  ): Promise<void> => {
    if (!transfer.transactionHash) {
      throw new Error("Curve transfer has no transaction provenance")
    }
    const receipt = await provider.getTransactionReceipt(
      transfer.transactionHash,
    )
    if (!receipt || receipt.status !== 1) {
      throw new Error(`Curve transaction ${transfer.transactionHash} failed`)
    }
    if (
      receipt.blockNumber > blockNumber ||
      !transfer.blockHash ||
      receipt.blockHash.toLowerCase() !== transfer.blockHash.toLowerCase() ||
      !sameAddress(receipt.from, depositor) ||
      !receipt.to ||
      !sameAddress(receipt.to, anchors.CURVE_ROUTER_V1_1)
    ) {
      throw new Error(
        `Curve transaction ${transfer.transactionHash} has unexpected ` +
          "block number, block hash, sender, or receiver",
      )
    }
    const logs = receiptLogs(receipt)
    const hasInput = logs.some((log) =>
      transferMatches(
        log,
        stbtcAddress,
        depositor,
        anchors.CURVE_ROUTER_V1_1,
        transfer.amountWei,
      ),
    )
    const fullyForwarded = logs.some((log) => {
      if (
        !sameAddress(log.address, stbtcAddress) ||
        log.topics[0] !== TRANSFER_TOPIC ||
        log.topics.length < 3 ||
        !sameAddress(addressFromTopic(log.topics[1]), anchors.CURVE_ROUTER_V1_1)
      ) {
        return false
      }
      return BigInt(log.data) === transfer.amountWei
    })
    const hasTbtcOutput = logs.some(
      (log) =>
        transferMatches(
          log,
          tbtcAddress,
          anchors.CURVE_ROUTER_V1_1,
          depositor,
        ) && BigInt(log.data) > 0n,
    )
    const unexpectedRouterOutput = logs.some((log) => {
      if (
        log.topics[0] !== TRANSFER_TOPIC ||
        log.topics.length < 3 ||
        !sameAddress(
          addressFromTopic(log.topics[1]),
          anchors.CURVE_ROUTER_V1_1,
        ) ||
        !sameAddress(addressFromTopic(log.topics[2]), depositor)
      ) {
        return false
      }
      return !sameAddress(log.address, tbtcAddress)
    })
    // A Curve route that mints an LP/share token directly to the receiver is
    // still an external claim even if the router also moves tBTC dust. For a
    // reviewed stBTC-to-tBTC swap, tBTC is the only Transfer-event token that
    // may arrive at the depositor in this transaction.
    const unexpectedTokenReceipt = logs.some(
      (log) =>
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length >= 3 &&
        sameAddress(addressFromTopic(log.topics[2]), depositor) &&
        !sameAddress(log.address, tbtcAddress),
    )
    if (
      !hasInput ||
      !fullyForwarded ||
      !hasTbtcOutput ||
      unexpectedRouterOutput ||
      unexpectedTokenReceipt
    ) {
      throw new Error(
        `Curve transaction ${transfer.transactionHash} is not a fully ` +
          "reconciled stBTC-to-tBTC swap back to the depositor",
      )
    }
  }

  const verifyUniswapPool = async (): Promise<void> => {
    await verifyProtocolIdentities()
    const [factory, token0, token1, fee] = await Promise.all([
      uniswapPool.factory(callOverrides),
      uniswapPool.token0(callOverrides),
      uniswapPool.token1(callOverrides),
      uniswapPool.fee(callOverrides),
    ])
    if (!sameAddress(factory, anchors.UNISWAP_V3_FACTORY)) {
      throw new Error(`Uniswap pool reports unexpected factory ${factory}`)
    }
    const pair = new Set([canonicalAddress(token0), canonicalAddress(token1)])
    if (
      !pair.has(canonicalAddress(tbtcAddress)) ||
      !pair.has(canonicalAddress(stbtcAddress))
    ) {
      throw new Error(
        `Uniswap pool reports unexpected pair ${token0}/${token1}`,
      )
    }
    if (Number(fee) !== anchors.UNISWAP_V3_TBTC_STBTC_POOL_FEE) {
      throw new Error(`Uniswap pool reports unexpected fee ${fee.toString()}`)
    }
    const registeredPool = await uniswapFactory.getPool(
      token0,
      token1,
      fee,
      callOverrides,
    )
    if (!sameAddress(registeredPool, anchors.UNISWAP_V3_TBTC_STBTC_POOL)) {
      throw new Error(
        `Uniswap factory registered unexpected pool ${registeredPool}`,
      )
    }
  }

  // Pool identities are immutable, so one read per emitting contract serves
  // every depositor screened through this reader.
  const poolIdentities = new Map<string, Promise<UniswapV3PoolIdentity>>()
  const readPoolIdentity = (pool: string): Promise<UniswapV3PoolIdentity> => {
    const key = canonicalAddress(pool)
    let pending = poolIdentities.get(key)
    if (!pending) {
      pending = (async () => {
        const contract = new Contract(key, UNISWAP_V3_POOL_ABI, provider)
        const [factory, token0, token1, fee] = await Promise.all([
          contract.factory(callOverrides),
          contract.token0(callOverrides),
          contract.token1(callOverrides),
          contract.fee(callOverrides),
        ])
        return {
          factory: canonicalAddress(factory),
          token0: canonicalAddress(token0),
          token1: canonicalAddress(token1),
          fee: Number(fee),
        }
      })()
      poolIdentities.set(key, pending)
    }
    return pending
  }

  return {
    async getSentTransfers(depositor) {
      const logs = await getHistoricalLogs(
        `stbtc-sent:${canonicalAddress(depositor)}`,
        {
          address: stbtcAddress,
          topics: [TRANSFER_TOPIC, paddedAddress(depositor)],
        },
      )
      return logs.map((log) => ({
        destination: addressFromTopic(log.topics[2]),
        amountWei: BigInt(log.data),
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.index,
      }))
    },
    async getTotalReceivedWei(depositor) {
      const logs = await getHistoricalLogs(
        `stbtc-received:${canonicalAddress(depositor)}`,
        {
          address: stbtcAddress,
          topics: [TRANSFER_TOPIC, null, paddedAddress(depositor)],
        },
      )
      return logs.reduce((total, log) => total + BigInt(log.data), 0n)
    },
    async getStbtcBalance(address) {
      return BigInt(await stbtc.balanceOf(address, callOverrides))
    },
    async getCode(address) {
      return provider.getCode(address, blockHash)
    },
    async getTokenBalance(token, holder) {
      const contract = new Contract(token, ERC20_ABI, provider)
      return BigInt(await contract.balanceOf(holder, callOverrides))
    },
    async getTokenSymbol(token) {
      const contract = new Contract(token, ERC20_ABI, provider)
      return `${await contract.symbol(callOverrides)}`
    },
    async resolveKnownDestination(depositor, destination, transfers) {
      if (sameAddress(destination, anchors.PORTAL)) {
        try {
          const implementation = await verifyPortalSinkIdentity(
            provider,
            blockHash,
          )
          return {
            adapter: "portal-sink",
            status: "noClaim",
            evidence:
              `Portal proxy points to reviewed implementation ${implementation}; ` +
              "transfers to it create no depositor-owned external claim",
          }
        } catch (error) {
          return {
            adapter: "portal-sink",
            status: "unresolved",
            evidence: errorMessage(error),
          }
        }
      }

      if (sameAddress(destination, anchors.CURVE_ROUTER_V1_1)) {
        try {
          await verifyProtocolIdentities()
          const version = `${await curveRouter.version(callOverrides)}`
          if (version !== "1.1.0") {
            throw new Error(`unexpected Curve router version ${version}`)
          }
          // eslint-disable-next-line no-restricted-syntax
          for (const transfer of transfers) {
            // eslint-disable-next-line no-await-in-loop
            await verifyCurveTransfer(depositor, transfer)
          }
          return {
            adapter: "curve-router-v1.1",
            status: "noClaim",
            evidence:
              `${transfers.length} stBTC-to-tBTC swap transaction(s) ` +
              "reconciled; exact router code/version has no share ledger",
          }
        } catch (error) {
          return {
            adapter: "curve-router-v1.1",
            status: "unresolved",
            evidence: errorMessage(error),
          }
        }
      }

      if (sameAddress(destination, anchors.UNISWAP_V3_TBTC_STBTC_POOL)) {
        try {
          await verifyUniswapPool()
          return {
            adapter: "uniswap-v3-pool",
            status: "noClaim",
            evidence:
              "exact canonical tBTC/stBTC pool; position-manager NFTs and " +
              "direct core ranges are screened independently",
          }
        } catch (error) {
          return {
            adapter: "uniswap-v3-pool",
            status: "unresolved",
            evidence: errorMessage(error),
          }
        }
      }
      return undefined
    },
    async getUniswapV3Positions(depositor) {
      await verifyProtocolIdentities()
      const [incoming, outgoing] = await Promise.all([
        getHistoricalLogs(
          `uniswap-nft-received:${canonicalAddress(depositor)}`,
          {
            address: anchors.UNISWAP_V3_POSITION_MANAGER,
            topics: [TRANSFER_TOPIC, null, paddedAddress(depositor)],
          },
        ),
        getHistoricalLogs(`uniswap-nft-sent:${canonicalAddress(depositor)}`, {
          address: anchors.UNISWAP_V3_POSITION_MANAGER,
          topics: [TRANSFER_TOPIC, paddedAddress(depositor)],
        }),
      ])
      // A self-transfer matches both queries. Deduplicate by log identity and
      // derive direction from the actual `to` topic so it cannot hide a live
      // position by being processed once as incoming and once as outgoing.
      const eventsById = new Map<string, Log>()
      ;[...incoming, ...outgoing].forEach((log) => {
        eventsById.set(`${log.transactionHash}:${log.index}`, log)
      })
      const ownershipEvents = Array.from(eventsById.values()).sort(
        (left, right) => {
          if (left.blockNumber !== right.blockNumber) {
            return left.blockNumber - right.blockNumber
          }
          if (left.transactionIndex !== right.transactionIndex) {
            return left.transactionIndex - right.transactionIndex
          }
          return left.index - right.index
        },
      )
      const currentlyOwned = new Map<bigint, boolean>()
      ownershipEvents.forEach((log) => {
        if (log.topics.length < 4) {
          throw new Error(`malformed position NFT Transfer log ${log.index}`)
        }
        currentlyOwned.set(
          BigInt(log.topics[3]),
          sameAddress(addressFromTopic(log.topics[2]), depositor),
        )
      })

      const ownedTokenIds = Array.from(currentlyOwned.entries())
        .filter(([, isOwned]) => isOwned)
        .map(([tokenId]) => tokenId)
      const nftPositionReports = await Promise.all(
        ownedTokenIds.map(async (tokenId) => {
          const owner = await positionManager.ownerOf(tokenId, callOverrides)
          if (!sameAddress(owner, depositor)) {
            throw new Error(
              `position ${tokenId.toString()} ownership disagrees with Transfer history`,
            )
          }
          const position = await positionManager.positions(
            tokenId,
            callOverrides,
          )
          const token0 = canonicalAddress(position[2])
          const token1 = canonicalAddress(position[3])
          if (
            !sameAddress(token0, stbtcAddress) &&
            !sameAddress(token1, stbtcAddress)
          ) {
            return undefined
          }
          const registeredPool = await uniswapFactory.getPool(
            token0,
            token1,
            position[4],
            callOverrides,
          )
          if (
            sameAddress(
              registeredPool,
              "0x0000000000000000000000000000000000000000",
            )
          ) {
            throw new Error(
              `position ${tokenId.toString()} has no canonical Uniswap V3 pool`,
            )
          }
          return {
            adapter: "uniswap-v3-nft" as const,
            tokenId,
            owner: canonicalAddress(owner),
            token0,
            token1,
            fee: Number(position[4]),
            liquidity: BigInt(position[7]),
            tokensOwed0: BigInt(position[10]),
            tokensOwed1: BigInt(position[11]),
          }
        }),
      )
      const filteredNftPositions = nftPositionReports.filter(
        (position): position is ExternalStbtcNftPositionReport =>
          position !== undefined,
      )

      // Direct (non-NFT) core positions: see enumerateDirectCorePositions.
      // The Mint query carries no pool address on purpose — every canonical
      // stBTC pool is in scope; factory history authenticates each emitter.
      const corePositions = await enumerateDirectCorePositions(
        depositor,
        stbtcAddress,
        {
          getDirectMintLogs: (owner) =>
            getHistoricalLogs(`uniswap-core-mint:${canonicalAddress(owner)}`, {
              topics: [UNISWAP_V3_MINT_TOPIC, paddedAddress(owner)],
            }),
          getStbtcPoolCreationLogs,
          getPoolIdentity: readPoolIdentity,
          getRegisteredPool: async (token0, token1, fee) =>
            canonicalAddress(
              await uniswapFactory.getPool(token0, token1, fee, callOverrides),
            ),
          getCorePosition: async (pool, key) => {
            const position = await new Contract(
              pool,
              UNISWAP_V3_POOL_ABI,
              provider,
            ).positions(key, callOverrides)
            return {
              liquidity: BigInt(position[0]),
              tokensOwed0: BigInt(position[3]),
              tokensOwed1: BigInt(position[4]),
            }
          },
        },
      )
      return [...filteredNftPositions, ...corePositions]
    },
  }
}
