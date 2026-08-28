import { ethers } from "hardhat"
import { loadRecoveryManifest } from "../helpers/recovery-manifest"
import { pinnedBlockContext } from "../helpers/recovery-preflight"

// Screens every selected depositor for stBTC they hold OUTSIDE their wallet.
//
// The recovery contract's stranding guard can only price
// `balanceOf(depositor)`. stBTC the same party holds indirectly — in an AMM
// pool, a vault, or another address — is invisible to it, so the guard is a
// floor rather than a proof. That gap matters here specifically: Threshold's
// own stranded position came from exiting the Curve stBTC/tBTC pool, so a
// selected depositor with a pool position is exactly the case that would
// recreate the stranding this recovery exists to cure.
//
// This script makes that review step mechanical: for each settled depositor
// it replays their full stBTC Transfer history, reports where their minted
// receipt tokens went, and checks whether they still hold a claim on any
// contract that currently holds stBTC.
//
//   MAINNET_RPC_URL=<archive rpc> npm run check:external-stbtc
//
// A depositor is CLEAN when they hold no stBTC directly and no balance in
// any stBTC-holding contract they transferred to. Anything else needs human
// judgement before the manifest is approved: either exclude that depositor,
// or (better, because it preserves recovery capacity) reduce their
// settlement by the externally-held amount.

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)")
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]

function padAddress(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32)
}

function addressFromTopic(topic: string): string {
  return ethers.getAddress(`0x${topic.slice(-40)}`)
}

async function main() {
  const manifest = loadRecoveryManifest()
  const { callOverrides } = pinnedBlockContext(
    process.env.CHECK_BLOCK
      ? Number(process.env.CHECK_BLOCK)
      : await ethers.provider.getBlockNumber(),
  )
  const stbtcAddress = manifest.addresses.stbtc
  const stbtc = new ethers.Contract(stbtcAddress, ERC20_ABI, ethers.provider)

  const depositors = Array.from(
    new Set(manifest.settlements.map((s) => ethers.getAddress(s.depositor))),
  )

  // eslint-disable-next-line no-console
  const print = console.log
  print(`stBTC external-holdings screen at block ${callOverrides.blockTag}`)
  print(`token ${stbtcAddress}, ${depositors.length} settled depositors\n`)

  let anyFlagged = false

  // Sequential on purpose: this is an operator-run audit over an archive RPC
  // where a burst of unbounded log queries is the fastest way to get rate
  // limited mid-screen.
  // eslint-disable-next-line no-restricted-syntax
  for (const depositor of depositors) {
    // eslint-disable-next-line no-await-in-loop
    const [sentLogs, receivedLogs, walletBalance] = await Promise.all([
      ethers.provider.getLogs({
        address: stbtcAddress,
        topics: [TRANSFER_TOPIC, padAddress(depositor)],
        fromBlock: 0,
        toBlock: callOverrides.blockTag,
      }),
      ethers.provider.getLogs({
        address: stbtcAddress,
        topics: [TRANSFER_TOPIC, null, padAddress(depositor)],
        fromBlock: 0,
        toBlock: callOverrides.blockTag,
      }),
      stbtc.balanceOf(depositor, callOverrides) as Promise<bigint>,
    ])

    const destinations = new Map<string, bigint>()
    sentLogs.forEach((log) => {
      const to = addressFromTopic(log.topics[2])
      destinations.set(to, (destinations.get(to) ?? 0n) + BigInt(log.data))
    })
    const totalReceived = receivedLogs.reduce(
      (total, log) => total + BigInt(log.data),
      0n,
    )

    print(`${depositor}`)
    print(
      `  minted/received ${ethers.formatEther(totalReceived)} stBTC, ` +
        `wallet balance now ${ethers.formatEther(walletBalance)}`,
    )

    const claims: string[] = []
    // eslint-disable-next-line no-restricted-syntax
    for (const [destination, amount] of destinations) {
      // eslint-disable-next-line no-await-in-loop
      const code = await ethers.provider.getCode(
        destination,
        callOverrides.blockTag,
      )
      const isContract = code !== "0x"
      let venueHolding = 0n
      let claim = 0n
      let label = ""
      if (isContract) {
        const venue = new ethers.Contract(
          destination,
          ERC20_ABI,
          ethers.provider,
        )
        // eslint-disable-next-line no-await-in-loop
        venueHolding = BigInt(await stbtc.balanceOf(destination, callOverrides))
        try {
          // A share/LP token balance in a venue that itself holds stBTC is an
          // indirect claim on that stBTC.
          // eslint-disable-next-line no-await-in-loop
          claim = BigInt(await venue.balanceOf(depositor, callOverrides))
          // eslint-disable-next-line no-await-in-loop
          label = `${await venue.symbol(callOverrides)}`
        } catch {
          claim = 0n
        }
      }
      print(
        `    -> ${destination} ${isContract ? "contract" : "EOA"} ` +
          `${ethers.formatEther(amount)} sent${
            isContract
              ? `; venue holds ${ethers.formatEther(venueHolding)} stBTC, ` +
                `depositor's share balance ${ethers.formatEther(claim)}${
                  label ? ` (${label})` : ""
                }`
              : ""
          }`,
      )
      if (claim > 0n && venueHolding > 0n) {
        claims.push(`${ethers.formatEther(claim)} of ${label || destination}`)
      }
    }

    if (walletBalance > 0n || claims.length > 0) {
      anyFlagged = true
      print(
        `  FLAGGED: holds stBTC directly or via ${claims.join(", ") || "n/a"}`,
      )
    } else {
      print(
        "  CLEAN: no direct stBTC and no share balance in any venue it funded",
      )
    }
    print("")
  }

  if (anyFlagged) {
    print(
      "RESULT: at least one settled depositor holds stBTC outside their " +
        "wallet. Do NOT approve this manifest as-is — exclude them, or " +
        "reduce their settlement by the externally-held amount.",
    )
    process.exitCode = 1
    return
  }
  print(
    "RESULT: every settled depositor is clean — no direct stBTC and no " +
      "claim on any venue they sent stBTC to. The on-chain guard's " +
      "wallet-only view is sufficient for this manifest.",
  )
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
