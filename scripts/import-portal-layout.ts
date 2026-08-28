import { ethers, upgrades } from "hardhat"
import { loadRecoveryManifest } from "../helpers/recovery-manifest"

// Reconciles .openzeppelin/mainnet.json with the implementation actually
// installed behind the live Portal proxy. The network file predates the
// live implementation, so without this the upgrades plugin would validate
// storage layouts against a stale implementation (or refuse to work) for
// any future operation on the proxy. Requires MAINNET_RPC_URL:
//
//   npx hardhat run scripts/import-portal-layout.ts --network mainnet
//
// The local Portal source must compile to the live runtime bytecode (the
// provenance test enforces this), so the recorded layout is the live one.
async function main() {
  const Portal = await ethers.getContractFactory("Portal")
  const proxy = loadRecoveryManifest().addresses.portal
  await upgrades.forceImport(proxy, Portal, { kind: "transparent" })

  const implementation = await upgrades.erc1967.getImplementationAddress(proxy)
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
