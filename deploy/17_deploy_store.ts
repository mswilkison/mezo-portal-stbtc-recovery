import { getNamedAccounts } from "hardhat"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { to1e18 } from "@keep-network/hardhat-helpers/dist/number"
import waitForTransaction from "../helpers/deploy-helpers"

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, helpers } = hre
  const { log, execute } = deployments

  const { deployer } = await helpers.signers.getNamedSigners()

  const { governance, storeTreasuryMultisig, storeManager } =
    await getNamedAccounts()

  let deployment = await deployments.getOrNull("Store")

  // TODO: Confirm product details before deploying to mainnet.
  const products: {
    id: number
    price: bigint
    stock: number
    perCustomerLimit: number
  }[] = [
    // Ledger Devices
    {
      id: 1001, // Ledger Nano X [Code]
      price: to1e18(149),
      stock: 200,
      perCustomerLimit: 1,
    },
    {
      id: 1002, // Ledger Stax [Code]
      price: to1e18(399),
      stock: 100,
      perCustomerLimit: 1,
    },
    // Bitrefill Gift Cards
    {
      id: 1003, // Bitrefill $25 [Code]
      price: to1e18(25),
      stock: 200,
      perCustomerLimit: 0,
    },
    {
      id: 1004, // Bitrefill $50 [Code]
      price: to1e18(50),
      stock: 200,
      perCustomerLimit: 0,
    },
    {
      id: 1005, // Bitrefill $100 [Code]
      price: to1e18(100),
      stock: 100,
      perCustomerLimit: 0,
    },
    {
      id: 1006, // Bitrefill $200 [Code]
      price: to1e18(200),
      stock: 25,
      perCustomerLimit: 0,
    },
  ]

  if (deployment && helpers.address.isValid(deployment.address)) {
    log(`Using Store at ${deployment.address}`)
  } else {
    log("Deploying Store contract...")

    const musdAddress = (await deployments.get("MUSD")).address

    ;[, deployment] = await helpers.upgrades.deployProxy("Store", {
      contractName: "Store",
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

    // Initialize the products.
    // eslint-disable-next-line no-restricted-syntax
    for (const { id, price, stock, perCustomerLimit } of products) {
      log(
        `Updating product details for ${id} to:\n  price: ${price}\n  stock: ${stock}\n  perCustomerLimit: ${perCustomerLimit}`,
      )

      // eslint-disable-next-line no-await-in-loop
      await execute(
        "Store",
        { from: deployer.address, waitConfirmations: 1 },
        "updateProductPrice",
        id,
        price,
      )

      // eslint-disable-next-line no-await-in-loop
      await execute(
        "Store",
        { from: deployer.address, waitConfirmations: 1 },
        "updateProductStock",
        id,
        stock,
      )

      // eslint-disable-next-line no-await-in-loop
      await execute(
        "Store",
        { from: deployer.address, waitConfirmations: 1 },
        "updateProductPerCustomerLimit",
        id,
        perCustomerLimit,
      )
    }

    // Update the store manager.
    log(`Updating store manager to ${storeManager}`)
    await execute(
      "Store",
      { from: deployer.address, waitConfirmations: 1 },
      "updateStoreManager",
      storeManager,
    )

    // Update the store treasury.
    log(`Updating store treasury to ${storeTreasuryMultisig}`)
    await execute(
      "Store",
      { from: deployer.address, waitConfirmations: 1 },
      "updateStoreTreasury",
      storeTreasuryMultisig,
    )

    // Transfer ownership to the governance
    log(`Transferring ownership of Store to ${governance}`)
    await deployments.execute(
      "Store",
      { from: deployer.address, log: true, waitConfirmations: 1 },
      "transferOwnership",
      governance,
    )

    // TODO: Don't execute this on mainnet as the governance will be a multisig.
    // if (hre.network.name !== "mezoMainnet") {
    await deployments.execute(
      "Store",
      { from: governance, log: true, waitConfirmations: 1 },
      "acceptOwnership",
    )
    // }
  }
}

export default func

func.tags = ["Store"]
func.dependencies = ["ResolveMusdToken"]

func.skip = async (hre) =>
  hre.network.name !== "matsnet" && hre.network.name !== "hardhat"
