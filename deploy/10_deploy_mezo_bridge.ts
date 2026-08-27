import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import waitForTransaction from "../helpers/deploy-helpers"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, network, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer } = await helpers.signers.getNamedSigners()
  const { governance } = await getNamedAccounts()

  const tbtcAddress = (await deployments.get("TBTC")).address
  const bridgeAddress = (await deployments.get("Bridge")).address
  const tbtcVaultAddress = (await deployments.get("TBTCVault")).address

  const MezoBridge = await deployments.getOrNull("MezoBridge")

  const isValidDeployment =
    MezoBridge && helpers.address.isValid(MezoBridge.address)

  if (isValidDeployment) {
    log(`Using MezoBridge at ${MezoBridge.address}`)
  } else {
    log("Deploying MezoBridge contract...")

    const [_, mezoBridgeDeployment] = await helpers.upgrades.deployProxy(
      "MezoBridge",
      {
        contractName: "MezoBridge",
        initializerArgs: [bridgeAddress, tbtcVaultAddress, tbtcAddress, 0],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
          initialOwner: governance,
        },
      },
    )

    if (mezoBridgeDeployment.transactionHash && hre.network.tags.etherscan) {
      const confirmationsByChain: Record<string, number> = {
        mainnet: 6,
        sepolia: 12,
      }

      await waitForTransaction(
        hre,
        mezoBridgeDeployment.transactionHash,
        confirmationsByChain[network.name],
      )
      await helpers.etherscan.verify(mezoBridgeDeployment)
    }
  }
}

export default func

func.tags = ["MezoBridge"]
func.dependencies = ["ResolveTbtcBridge", "ResolveTbtcVault"]
