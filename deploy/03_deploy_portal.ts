import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import waitForTransaction from "../helpers/deploy-helpers"
import { TokenAbility } from "../types"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers, network, getNamedAccounts } = hre
  const { log } = deployments
  const { deployer } = await helpers.signers.getNamedSigners()
  const { governance } = await getNamedAccounts()

  const deployment = await deployments.getOrNull("Portal")
  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using Portal at ${deployment.address}`)
  } else {
    log("Deploying Portal contract...")
    const tbtcAddress = (await deployments.get("TBTC")).address
    const wbtcAddress = (await deployments.get("WBTC")).address

    const supportedTokens = [
      { token: tbtcAddress, tokenAbility: TokenAbility.DepositAndLock },
      { token: wbtcAddress, tokenAbility: TokenAbility.DepositAndLock },
    ]

    log("Supported tokens: ", supportedTokens)

    const [_, portalDeployment] = await helpers.upgrades.deployProxy("Portal", {
      contractName: "Portal",
      initializerArgs: [supportedTokens],
      factoryOpts: { signer: deployer },
      proxyOpts: {
        kind: "transparent",
        initialOwner: governance,
      },
    })

    if (portalDeployment.transactionHash && hre.network.tags.etherscan) {
      const confirmationsByChain: Record<string, number> = {
        mainnet: 6,
        sepolia: 12,
      }

      await waitForTransaction(
        hre,
        portalDeployment.transactionHash,
        confirmationsByChain[network.name],
      )
      await helpers.etherscan.verify(portalDeployment)
    }
  }
}

export default func

func.tags = ["Portal"]
func.dependencies = ["ResolveTbtcToken", "ResolveWbtcToken"]
