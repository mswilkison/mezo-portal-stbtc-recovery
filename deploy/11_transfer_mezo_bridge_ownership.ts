import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer, governance } = await getNamedAccounts()

  log("Transferring MezoBridge ownership to ", governance)
  await helpers.ownable.transferOwnership("MezoBridge", governance, deployer)
}

export default func

func.tags = ["TransferMezoBridgeOwnership"]
func.dependencies = ["MezoBridge"]
