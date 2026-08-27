import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, network, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer } = await getNamedAccounts()

  const Bridge = await deployments.getOrNull("Bridge")

  const isValidDeployment = Bridge && helpers.address.isValid(Bridge.address)

  if (isValidDeployment) {
    log(`Using Bridge at ${Bridge.address}`)
    return
  }

  // tBTC Bridge should exist for all networks but local "hardhat" network
  // used for unit tests.
  if (network.name === "hardhat") {
    log("Deploying mock tBTC Bridge contract...")
    await deployments.deploy("Bridge", {
      contract: "contracts/tests/MockTBTC.sol:MockBridge",
      from: deployer,
      log: true,
      waitConfirmations: 1,
    })
  } else {
    throw new Error("unable to resolve Bridge; check /external")
  }
}

export default func

func.tags = ["ResolveTbtcBridge"]
