import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, network, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer } = await getNamedAccounts()

  const TBTCVault = await deployments.getOrNull("TBTCVault")

  const isValidDeployment =
    TBTCVault && helpers.address.isValid(TBTCVault.address)

  if (isValidDeployment) {
    log(`Using TBTCVault at ${TBTCVault.address}`)
    return
  }

  // TBTCVault should exist for all networks but local "hardhat" network
  // used for unit tests.
  if (network.name === "hardhat") {
    log("Deploying mock TBTCVault contract...")

    const tbtcAddress = (await deployments.get("TBTC")).address
    const bridgeAddress = (await deployments.get("Bridge")).address

    await deployments.deploy("TBTCVault", {
      contract: "contracts/tests/MockTBTC.sol:MockTBTCVault",
      args: [tbtcAddress, bridgeAddress],
      from: deployer,
      log: true,
      waitConfirmations: 1,
    })
  } else {
    throw new Error("unable to resolve TBTCVault; check /external")
  }
}

export default func

func.tags = ["ResolveTbtcVault"]
