import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer, governance } = await getNamedAccounts()

  log("Transferring Portal ownership to ", governance)
  await helpers.ownable.transferOwnership("Portal", governance, deployer)
}

export default func

func.tags = ["TransferPortalOwnership"]
func.dependencies = ["Portal"]
