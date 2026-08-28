import { ethers, network, upgrades } from "hardhat"

// This test deploys a local proxy, which needs the in-process hardhat
// network's signers. Skip by actual capability (the selected network), not
// by NODE_ENV sniffing: `npm run test:upgrades` sweeps this directory
// against the remote mainnet_fork network and must skip it, while any run
// on the hardhat network (test:recovery, bare hardhat test — whatever
// NODE_ENV happens to be) must execute it.
const describeFn = network.name === "hardhat" ? describe : describe.skip

describeFn("PortalStbtcRecovery - storage layout", () => {
  it("is storage-compatible with the reconstructed live Portal", async () => {
    const signers = await ethers.getSigners()
    const addresses = await Promise.all(
      signers.slice(1, 5).map((signer) => signer.getAddress()),
    )
    const amount = ethers.parseEther("1")

    const Portal = await ethers.getContractFactory("Portal")
    const Recovery = await ethers.getContractFactory("PortalStbtcRecovery")
    const portal = await upgrades.deployProxy(Portal, [[]], {
      kind: "transparent",
      initialOwner: await signers[0].getAddress(),
    })
    await portal.waitForDeployment()

    const portalAddress = await portal.getAddress()
    const proxyAdmin = await upgrades.erc1967.getAdminAddress(portalAddress)

    await upgrades.validateUpgrade(portalAddress, Recovery, {
      kind: "transparent",
      constructorArgs: [portalAddress, proxyAdmin, ...addresses, amount],
      unsafeAllow: ["constructor", "state-variable-immutable"],
    })
  })
})
