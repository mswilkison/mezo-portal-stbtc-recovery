import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import waitForTransaction from "../helpers/deploy-helpers"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, helpers, network } = hre
  const { log } = deployments
  const { deployer, governance } = await getNamedAccounts()

  const deployment = await deployments.getOrNull("PortalProxyAdminTimelock")
  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using PortalProxyAdminTimelock at ${deployment.address}`)
  } else {
    const timelock = await deployments.deploy("PortalProxyAdminTimelock", {
      contract: "Timelock",
      from: deployer,
      args: [
        86400, // 24h governance delay
        [governance], // Mezo governance multisig
        // The Mezo governance multisig itself and the current signers from
        // the governance as executors.
        // See https://app.safe.global/settings/setup?safe=eth:0x98d8899c3030741925be630c710a98b57f397c7a
        [
          governance,
          "0x7f043FF8B5Ce02E543eE83fcdec94944D24ebD5d",
          "0x09C146B526E5139E0bDe31aF85AD44761eC70d00",
          "0x930b76784C1FB86335ab174dFE321B44eA0ADfdA",
          "0xAbB0C40DBc7FF3455087888C87217064Ad10a944",
          "0x9bE76D5aB050aa8c77f6Ad25F25f633B2cB8ed85",
          "0x696BA87e3Ef864335A9E30Ae4653b516Fb93a1AB",
          "0x351a1C1bE5fE133204DBd74789dA67c68e40A84c",
          "0xF63bc5326c4d5ab123a20Ec5D5805B365a3355E4",
          "0xc3b6Ee418d6A747B6Fcd21d5D7A1F27D435301B0",
        ],
      ],
      log: true,
      waitConfirmations: 1,
    })

    if (timelock.transactionHash && hre.network.tags.etherscan) {
      const confirmationsByChain: Record<string, number> = {
        mainnet: 6,
        sepolia: 12,
      }

      await waitForTransaction(
        hre,
        timelock.transactionHash,
        confirmationsByChain[network.name],
      )
      await helpers.etherscan.verify(timelock)
    }
  }
}

export default func

func.tags = ["DeployTimelock"]
