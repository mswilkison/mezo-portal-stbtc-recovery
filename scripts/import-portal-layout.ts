import { artifacts, ethers, upgrades } from "hardhat"
import * as anchors from "../helpers/recovery-anchors"
import { loadRecoveryManifest } from "../helpers/recovery-manifest"

// Reconciles .openzeppelin/mainnet.json with the implementation actually
// installed behind the live Portal proxy. The network file predates the
// live implementation, so without this the upgrades plugin would validate
// storage layouts against a stale implementation (or refuse to work) for
// any future operation on the proxy. Requires MAINNET_RPC_URL:
//
//   npm run import:portal-layout
async function main() {
  const Portal = await ethers.getContractFactory("Portal")
  const proxy = loadRecoveryManifest().addresses.portal

  // Record the local compilation's layout ONLY if it is byte-for-byte the
  // implementation actually installed behind the proxy. Without this gate a
  // drifted local Portal.sol (or a lost evmVersion setting) would silently
  // write the wrong layout into .openzeppelin/mainnet.json keyed to the live
  // implementation, and every later validateUpgrade would check against a
  // wrong baseline. The provenance test enforces the same equality, but it
  // runs in a different command than this script's own invocation.
  const implementation = await upgrades.erc1967.getImplementationAddress(proxy)
  const liveHash = ethers.keccak256(
    await ethers.provider.getCode(implementation),
  )
  const artifact = await artifacts.readArtifact("Portal")
  const compiledHash = ethers.keccak256(artifact.deployedBytecode)

  if (compiledHash !== liveHash) {
    throw new Error(
      `refusing to import: local Portal compiles to ${compiledHash} but the ` +
        `live implementation ${implementation} is ${liveHash}. Rebuild ` +
        "(evmVersion paris) or re-sync Portal.sol before recording a layout",
    )
  }
  if (liveHash !== anchors.IMPLEMENTATION_RUNTIME_HASH) {
    throw new Error(
      `refusing to import: the live implementation ${implementation} is not ` +
        `the reviewed anchor (${anchors.IMPLEMENTATION_RUNTIME_HASH})`,
    )
  }

  await upgrades.forceImport(proxy, Portal, { kind: "transparent" })

  // eslint-disable-next-line no-console
  console.log(
    `recorded layout for implementation ${implementation} behind ${proxy}`,
  )
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
