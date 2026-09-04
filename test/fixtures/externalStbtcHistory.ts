import {
  BlockTag,
  Filter,
  Interface,
  Log,
  Provider,
  TransactionRequest,
  ZeroAddress,
  getAddress,
  keccak256,
  toBeHex,
} from "ethers"
import {
  ExternalStbtcReader,
  createEthersExternalStbtcReader,
  createExternalStbtcLogHistory,
} from "../../helpers/external-stbtc"
import * as anchors from "../../helpers/recovery-anchors"

const TOKEN_ABI = ["function balanceOf(address) view returns (uint256)"]
const NFT_ABI = [
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
]
const POOL_ABI = [
  "event Mint(address sender,address indexed owner,int24 indexed tickLower,int24 indexed tickUpper,uint128 amount,uint256 amount0,uint256 amount1)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function positions(bytes32) view returns (uint128,uint256,uint256,uint128,uint128)",
]
const FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)",
  "function getPool(address,address,uint24) view returns (address)",
]

type HistoryFixture = {
  owner: string
  stbtc: string
  firstBlock: number
  nextBlock: number
  blockHash: (height: number) => string
  queries: Filter[]
  ownerReads: bigint[]
  callBlocks: BlockTag[]
  readAt: (height: number, cached: boolean) => ExternalStbtcReader
}

// Exercise the production ethers reader against a deterministic archive
// fixture. Only the four code-hash pins are replaced to trust the fixture's
// code; all authentication and history checks still run, and the original
// pins are restored before this awaited, sequential test scope ends.
export default async function withExternalStbtcHistory(
  run: (fixture: HistoryFixture) => Promise<void>,
  options: {
    closedPositions?: boolean
    codeDrift?: boolean
    unreadableHistory?: "nft" | "core"
  } = {},
): Promise<void> {
  const owner = getAddress("0x0000000000000000000000000000000000000001")
  const other = getAddress("0x0000000000000000000000000000000000000002")
  const tbtc = getAddress("0x00000000000000000000000000000000000000aa")
  const stbtc = getAddress("0x00000000000000000000000000000000000000bb")
  const deployment = anchors.STBTC_DEPLOYMENT_BLOCK
  const firstBlock = deployment + 5
  const nextBlock = deployment + 7
  const blockHash = (height: number) => toBeHex(height, 32)
  const nft = new Interface(NFT_ABI)
  const pool = new Interface(POOL_ABI)
  const factory = new Interface(FACTORY_ABI)
  const token = new Interface(TOKEN_ABI)
  const logs: Log[] = []
  const event = (
    contract: Interface,
    address: string,
    name: string,
    args: unknown[],
    height: number,
  ) => {
    const fragment = contract.getEvent(name)
    if (!fragment) {
      throw new Error(`missing fixture event ${name}`)
    }
    logs.push({
      address,
      ...contract.encodeEventLog(fragment, args),
      blockNumber: height,
      blockHash: blockHash(height),
      transactionHash: toBeHex(logs.length + 1, 32),
      transactionIndex: 0,
      index: logs.length,
      removed: false,
    } as unknown as Log)
  }
  event(
    factory,
    anchors.UNISWAP_V3_FACTORY,
    "PoolCreated",
    [tbtc, stbtc, 10000, 200, anchors.UNISWAP_V3_TBTC_STBTC_POOL],
    deployment - 10,
  )
  const transfer = (
    from: string,
    to: string,
    tokenId: bigint,
    height: number,
  ) =>
    event(
      nft,
      anchors.UNISWAP_V3_POSITION_MANAGER,
      "Transfer",
      [from, to, tokenId],
      height,
    )
  transfer(ZeroAddress, owner, 11n, deployment - 8)
  transfer(owner, owner, 11n, deployment - 7)
  transfer(ZeroAddress, owner, 12n, deployment - 8)
  transfer(owner, other, 12n, deployment - 6)
  transfer(ZeroAddress, owner, 13n, deployment - 8)
  transfer(owner, ZeroAddress, 13n, deployment - 6)
  transfer(ZeroAddress, owner, 14n, deployment - 8)
  transfer(owner, other, 14n, deployment + 1)
  event(
    pool,
    anchors.UNISWAP_V3_TBTC_STBTC_POOL,
    "Mint",
    [other, owner, -60, 60, 7n, 1n, 0n],
    deployment - 5,
  )
  transfer(owner, other, 11n, deployment + 6)

  const queries: Filter[] = []
  const ownerReads: bigint[] = []
  const callBlocks: BlockTag[] = []
  const interfaces = new Map([
    [stbtc, token],
    [anchors.UNISWAP_V3_POSITION_MANAGER, nft],
    [anchors.UNISWAP_V3_TBTC_STBTC_POOL, pool],
    [anchors.UNISWAP_V3_FACTORY, factory],
  ])
  const provider = {
    getCode: async (address: string, blockTag: BlockTag) => {
      if (address === stbtc && blockTag === deployment - 1) {
        return "0x"
      }
      return options.codeDrift && address === anchors.UNISWAP_V3_FACTORY
        ? "0x02"
        : "0x01"
    },
    getLogs: async (filter: Filter) => {
      queries.push(filter)
      const start = Number(filter.fromBlock)
      const end = Number(filter.toBlock)
      if (
        start < deployment &&
        ((options.unreadableHistory === "nft" &&
          filter.address === anchors.UNISWAP_V3_POSITION_MANAGER) ||
          (options.unreadableHistory === "core" && !filter.address))
      ) {
        throw new Error("pre-deployment position history unavailable")
      }
      return logs.filter((log) => {
        const addresses =
          filter.address === undefined ? [] : [filter.address].flat()
        return (
          log.blockNumber >= start &&
          log.blockNumber <= end &&
          (addresses.length === 0 ||
            addresses.some(
              (address) =>
                String(address).toLowerCase() === log.address.toLowerCase(),
            )) &&
          (filter.topics ?? []).every(
            (topic, index) =>
              topic === null ||
              [topic]
                .flat()
                .some(
                  (value) =>
                    value.toLowerCase() === log.topics[index]?.toLowerCase(),
                ),
          )
        )
      })
    },
    call: async (request: TransactionRequest) => {
      const contract = interfaces.get(getAddress(String(request.to)))
      const decoded = contract?.parseTransaction({ data: String(request.data) })
      if (!contract || !decoded || typeof request.blockTag !== "string") {
        throw new Error("unexpected or unpinned fixture call")
      }
      callBlocks.push(request.blockTag)
      const later = request.blockTag === blockHash(nextBlock)
      let result: unknown[]
      switch (decoded.name) {
        case "balanceOf":
          result = [0n]
          break
        case "factory":
          result = [anchors.UNISWAP_V3_FACTORY]
          break
        case "token0":
          result = [tbtc]
          break
        case "token1":
          result = [stbtc]
          break
        case "fee":
          result = [10000]
          break
        case "getPool":
          result = [anchors.UNISWAP_V3_TBTC_STBTC_POOL]
          break
        case "ownerOf":
          ownerReads.push(BigInt(decoded.args[0]))
          if (decoded.args[0] !== 11n || later) {
            throw new Error("queried NFT no longer owned by depositor")
          }
          result = [owner]
          break
        case "positions":
          result =
            contract === nft
              ? [
                  0n,
                  ZeroAddress,
                  tbtc,
                  stbtc,
                  10000,
                  -60,
                  60,
                  options.closedPositions ? 0n : 5n,
                  0n,
                  0n,
                  0n,
                  0n,
                ]
              : [
                  options.closedPositions || later ? 0n : 7n,
                  0n,
                  0n,
                  !options.closedPositions && later ? 2n : 0n,
                  0n,
                ]
          break
        default:
          throw new Error(`unexpected fixture method ${decoded.name}`)
      }
      return contract.encodeFunctionResult(decoded.fragment, result)
    },
  } as unknown as Provider
  const history = createExternalStbtcLogHistory(tbtc, stbtc)
  const originalHashes = {
    CURVE_ROUTER_V1_1_RUNTIME_HASH: anchors.CURVE_ROUTER_V1_1_RUNTIME_HASH,
    UNISWAP_V3_FACTORY_RUNTIME_HASH: anchors.UNISWAP_V3_FACTORY_RUNTIME_HASH,
    UNISWAP_V3_TBTC_STBTC_POOL_RUNTIME_HASH:
      anchors.UNISWAP_V3_TBTC_STBTC_POOL_RUNTIME_HASH,
    UNISWAP_V3_POSITION_MANAGER_RUNTIME_HASH:
      anchors.UNISWAP_V3_POSITION_MANAGER_RUNTIME_HASH,
  }
  Object.assign(
    anchors,
    Object.fromEntries(
      Object.keys(originalHashes).map((key) => [key, keccak256("0x01")]),
    ),
  )
  try {
    await run({
      owner,
      stbtc,
      firstBlock,
      nextBlock,
      blockHash,
      queries,
      ownerReads,
      callBlocks,
      readAt: (height, cached) =>
        createEthersExternalStbtcReader(
          provider,
          tbtc,
          stbtc,
          height,
          blockHash(height),
          cached ? history : undefined,
        ),
    })
  } finally {
    Object.assign(anchors, originalHashes)
  }
}
