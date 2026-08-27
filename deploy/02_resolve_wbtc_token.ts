import { ethers } from "hardhat"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import waitForTransaction from "../helpers/deploy-helpers"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers, network } = hre
  const { log } = deployments
  const { deployer } = await getNamedAccounts()

  const WBTC = await deployments.getOrNull("WBTC")

  const isValidDeployment = WBTC && helpers.address.isValid(WBTC.address)

  if (isValidDeployment) {
    log(`Using WBTC at ${WBTC.address}`)
    return
  }

  // WBTC mock is deployed on the local "hardhat" network used for development
  // and tests as well as on "sepolia" network where there is no official WBTC
  // deployment.
  if (network.name === "hardhat") {
    log("Deploying mock WBTC contract...")

    const mockDeploy = await deployments.deploy("WBTC", {
      contract: "MockWBTC",
      from: deployer,
      args: [ethers.parseEther("100")],
      log: true,
      waitConfirmations: 1,
    })

    if (mockDeploy.transactionHash && hre.network.tags.etherscan) {
      const confirmationsByChain: Record<string, number> = {
        sepolia: 6,
      }

      await waitForTransaction(
        hre,
        mockDeploy.transactionHash,
        confirmationsByChain[network.name],
      )
      await helpers.etherscan.verify(mockDeploy)
    }
  } else {
    throw new Error("unable to resolve WBTC; check /external")
  }
}

export default func

func.tags = ["ResolveWbtcToken"]
