import { ethers, upgrades } from "hardhat"

// `npm run test:upgrades` sweeps this directory against the live-state
// mainnet_fork network, whose remote accounts cannot sign the local proxy
// deployment this test performs. It runs on the default hardhat network via
// `npm run test:recovery` instead.
const describeFn =
  process.env.NODE_ENV === "upgrades-test" ? describe.skip : describe

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
