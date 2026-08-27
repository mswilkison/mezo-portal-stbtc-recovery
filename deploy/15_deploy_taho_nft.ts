import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { address as troveManagerAddress } from "../external/matsnet/TroveManager.json"

const VERIFIER_ADDRESS = "0xba0e8042a48a752e739acdae8e69504cdc50ea3b"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network, helpers } = hre
  const { log } = deployments
  const { deployer } = await helpers.signers.getNamedSigners()

  const deployment = await deployments.getOrNull("TahoMezoNFT")

  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using TahoMezoNFT at ${deployment.address}`)
  } else {
    log("Deploying TahoMezoNFT contract...")

    const musdAddress = (await deployments.get("MUSD")).address

    const initializerArgs = {
      metadataUri: "https://taho.xyz/taho_x_mezo_nft.json",
      musd: musdAddress,
      troveManager: troveManagerAddress,
    }

    if (network.name === "hardhat") {
      await deployments.deploy("MockTroveManager", {
        contract: "MockTroveManager",
        from: deployer.address,
        args: [],
        log: true,
        waitConfirmations: 1,
      })

      const troveMock = (await deployments.get("MockTroveManager")).address

      initializerArgs.troveManager = troveMock
    }

    await helpers.upgrades.deployProxy("TahoMezoNFT", {
      contractName: "TahoMezoNFT",
      initializerArgs: [
        initializerArgs.metadataUri,
        initializerArgs.musd,
        initializerArgs.troveManager,
      ],
      factoryOpts: { signer: deployer },
      proxyOpts: {
        kind: "transparent",
        initialOwner: deployer.address,
      },
    })

    if (network.name === "matsnet") {
      const nft = await helpers.contracts.getContract("TahoMezoNFT")

      await nft.setVerifier(VERIFIER_ADDRESS)
    }
  }
}

export default func

func.tags = ["TahoMezoNFT"]
func.dependencies = ["ResolveMusdToken"]

func.skip = async (hre) =>
  hre.network.name !== "matsnet" && hre.network.name !== "hardhat"
