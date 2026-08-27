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
  const portalAddress = (await deployments.get("Portal")).address

  const BitcoinDepositor = await deployments.getOrNull("BitcoinDepositor")

  const isValidDeployment =
    BitcoinDepositor && helpers.address.isValid(BitcoinDepositor.address)

  if (isValidDeployment) {
    log(`Using BitcoinDepositor at ${BitcoinDepositor.address}`)
  } else {
    log("Deploying BitcoinDepositor contract...")

    const [_, bitcoinDepositorDeployment] = await helpers.upgrades.deployProxy(
      "BitcoinDepositor",
      {
        contractName: "BitcoinDepositor",
        initializerArgs: [
          bridgeAddress,
          tbtcVaultAddress,
          tbtcAddress,
          portalAddress,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
          initialOwner: governance,
        },
      },
    )

    if (
      bitcoinDepositorDeployment.transactionHash &&
      hre.network.tags.etherscan
    ) {
      const confirmationsByChain: Record<string, number> = {
        mainnet: 6,
        sepolia: 12,
      }

      await waitForTransaction(
        hre,
        bitcoinDepositorDeployment.transactionHash,
        confirmationsByChain[network.name],
      )
      await helpers.etherscan.verify(bitcoinDepositorDeployment)
    }
  }
}

export default func

func.tags = ["BitcoinDepositor"]
func.dependencies = ["Portal", "ResolveTbtcBridge", "ResolveTbtcVault"]
