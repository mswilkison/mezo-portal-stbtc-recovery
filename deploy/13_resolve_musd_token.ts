import { to1e18 } from "@keep-network/hardhat-helpers/dist/number"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers, network } = hre
  const { log } = deployments
  const { deployer } = await getNamedAccounts()

  const mUSD = await deployments.getOrNull("MUSD")

  const isValidDeployment = mUSD && helpers.address.isValid(mUSD.address)

  if (isValidDeployment) {
    log(`Using mUSD at ${mUSD.address}`)
    return
  }

  // mUSD should exist for all networks but local "hardhat" network
  // used for development and tests.
  if (network.name === "hardhat") {
    log("Deploying mUSD contract...")
    await deployments.deploy("MUSD", {
      contract: "MockERC20WithPermit",
      from: deployer,
      args: ["mUSD", "mUSD", to1e18("10000")],
      log: true,
      waitConfirmations: 1,
    })
  } else {
    throw new Error("unable to resolve mUSD contract; check /external")
  }
}

export default func

func.tags = ["ResolveMusdToken"]
