import { to1e18 } from "@keep-network/hardhat-helpers/dist/number"
import { getNamedAccounts } from "hardhat"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers } = hre
  const { log } = deployments
  const { deployer } = await helpers.signers.getNamedSigners()
  const { governance } = await getNamedAccounts()

  const deployment = await deployments.getOrNull("MatsnetStore")

  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using MatsnetStore at ${deployment.address}`)
  } else {
    log("Deploying MatsnetStore contract...")

    const musdAddress = (await deployments.get("MUSD")).address

    await helpers.upgrades.deployProxy("MatsnetStore", {
      contractName: "MatsnetStore",
      initializerArgs: [musdAddress],
      factoryOpts: { signer: deployer },
      proxyOpts: {
        kind: "transparent",
        initialOwner: governance,
      },
    })

    const store = await helpers.contracts.getContract("MatsnetStore")

    // Initialize products in the store.
    // 30 mUSD for a hat
    // 70 mUSD for a t-shirt
    // 130 mUSD for a hoodie
    await store.setProductPrice(
      "dac103b5-e0eb-49fa-806e-34089acd63fe",
      to1e18(30),
    )
    await store.setProductPrice(
      "36919d71-344b-4887-86b3-5ce903968a87",
      to1e18(70),
    )
    await store.setProductPrice(
      "7ba53af4-24ee-4261-a590-6dd90101b148",
      to1e18(130),
    )

    // Transfer ownership to the governance
    await store.transferOwnership(governance)
  }
}

export default func

func.tags = ["MatsnetStore"]
func.dependencies = ["ResolveMusdToken"]

func.skip = async (hre) =>
  hre.network.name !== "matsnet" && hre.network.name !== "hardhat"
