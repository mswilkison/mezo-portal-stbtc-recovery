import { getNamedAccounts } from "hardhat"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import waitForTransaction from "../helpers/deploy-helpers"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers } = hre
  const { log, execute } = deployments

  const { deployer, donationsTreasuryMultisig } =
    await helpers.signers.getNamedSigners()

  const { governance } = await getNamedAccounts()

  let deployment = await deployments.getOrNull("Donations")

  // TODO: Confirm these are the correct beneficiaries and recipients before deploying
  // to mainnet.
  const beneficiaries: { id: string; recipient: string }[] = [
    {
      id: "SheFi",
      recipient: donationsTreasuryMultisig.address,
    },
    {
      id: "Brink",
      recipient: donationsTreasuryMultisig.address,
    },
  ]

  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using Donations at ${deployment.address}`)
  } else {
    log("Deploying Donations contract...")

    const musdAddress = (await deployments.get("MUSD")).address

    ;[, deployment] = await helpers.upgrades.deployProxy("Donations", {
      contractName: "Donations",
      initializerArgs: [musdAddress],
      factoryOpts: { signer: deployer },
      proxyOpts: {
        kind: "transparent",
        initialOwner: governance,
      },
    })

    if (deployment.transactionHash && hre.network.tags.etherscan) {
      await waitForTransaction(hre, deployment.transactionHash)
      await helpers.etherscan.verify(deployment)
    }

    // Initialize the beneficiaries.
    // eslint-disable-next-line no-restricted-syntax
    for (const { id, recipient } of beneficiaries) {
      log(`Updating recipient address for ${id} to ${recipient}`)

      // eslint-disable-next-line no-await-in-loop
      await execute(
        "Donations",
        { from: deployer.address, waitConfirmations: 1 },
        "updateBeneficiary",
        id,
        recipient,
      )
    }

    // Transfer ownership to the governance
    log(`Transferring ownership of Donations to ${governance}`)
    await deployments.execute(
      "Donations",
      { from: deployer.address, log: true, waitConfirmations: 1 },
      "transferOwnership",
      governance,
    )

    // TODO: Don't execute this on mainnet as the governance will be a multisig.
    // if (hre.network.name !== "mezoMainnet") {
    await deployments.execute(
      "Donations",
      { from: governance, log: true, waitConfirmations: 1 },
      "acceptOwnership",
    )
    // }
  }
}

export default func

func.tags = ["Donations"]
func.dependencies = ["ResolveMusdToken"]

func.skip = async (hre) =>
  hre.network.name !== "matsnet" && hre.network.name !== "hardhat"
