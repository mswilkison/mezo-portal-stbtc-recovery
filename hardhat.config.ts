import { HardhatUserConfig } from "hardhat/config"
import "@keep-network/hardhat-helpers"
import "@nomicfoundation/hardhat-toolbox"
import "@nomicfoundation/hardhat-chai-matchers"
import "@openzeppelin/hardhat-upgrades"
import "hardhat-deploy"
import "hardhat-contract-sizer"
import "hardhat-gas-reporter"
import dotenv from "dotenv-safer"

dotenv.config({
  allowEmptyValues: true,
  example: process.env.CI ? ".env.ci.example" : ".env.example",
})

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL
  ? process.env.MAINNET_RPC_URL
  : ""

const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY
  ? [process.env.MAINNET_PRIVATE_KEY]
  : []

const MAINNET_FORK_BLOCK_NUMBER = process.env.MAINNET_FORK_BLOCK_NUMBER
  ? Number(process.env.MAINNET_FORK_BLOCK_NUMBER)
  : 25849540

const RECOVERY_FORK_ENABLED =
  process.env.NODE_ENV === "recovery-fork-test" && MAINNET_RPC_URL.length > 0

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL
  ? process.env.SEPOLIA_RPC_URL
  : ""

const MATSNET_RPC_URL = process.env.MATSNET_RPC_URL
  ? process.env.MATSNET_RPC_URL
  : ""

const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY
  ? [process.env.SEPOLIA_PRIVATE_KEY]
  : []

const MATSNET_PRIVATE_KEY = process.env.MATSNET_PRIVATE_KEY
  ? [process.env.MATSNET_PRIVATE_KEY]
  : []

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY
  ? process.env.ETHERSCAN_API_KEY
  : ""

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 10000,
      },
    },
  },
  typechain: {
    outDir: "typechain",
  },
  networks: {
    mainnet: {
      url: MAINNET_RPC_URL,
      accounts: MAINNET_PRIVATE_KEY,
      chainId: 1,
      tags: ["etherscan"],
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      accounts: SEPOLIA_PRIVATE_KEY,
      chainId: 11155111,
      tags: ["allowStubs", "etherscan"],
    },
    matsnet: {
      url: MATSNET_RPC_URL,
      accounts: MATSNET_PRIVATE_KEY,
      chainId: 31611,
      tags: ["etherscan"],
    },
    hardhat: {
      // TODO: Temporary fix. Remove once contract size is within limits.
      allowUnlimitedContractSize: true,
      tags: ["allowStubs"],
      accounts: {
        count: 100,
      },
      ...(RECOVERY_FORK_ENABLED
        ? {
            forking: {
              url: MAINNET_RPC_URL,
              blockNumber: MAINNET_FORK_BLOCK_NUMBER,
            },
          }
        : {}),
    },
    mainnet_fork: {
      url: MAINNET_RPC_URL,
      chainId: 1,
      forking: {
        url: MAINNET_RPC_URL,
        blockNumber: MAINNET_FORK_BLOCK_NUMBER,
      },
    },
  },
  external: {
    deployments: {
      matsnet: ["./external/matsnet"],
      sepolia: ["./external/sepolia"],
      mainnet: ["./external/mainnet"],
      mainnet_fork: ["./external/mainnet", "./deployments/mainnet"],
    },
  },
  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY,
      sepolia: ETHERSCAN_API_KEY,
      matsnet: "empty",
    },
    customChains: [
      {
        network: "matsnet",
        chainId: 31611,
        urls: {
          apiURL: "https://api.explorer.test.mezo.org/api",
          browserURL: "https://explorer.test.mezo.org",
        },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
    governance: {
      default: 1,
      mainnet: "0x98d8899c3030741925be630c710a98b57f397c7a",
      matsnet: "0x6e80164ea60673d64d5d6228beb684a1274bb017", // testertesting.eth
    },
    liquidityTreasuryMultisig: {
      default: 2,
      mainnet: "0x061110360ba50E19139a1Bf2EaF4004FB0dD31e8",
    },
    tbtcMigrationTreasuryMultisig: {
      default: 3,
      mainnet: "0x061110360ba50E19139a1Bf2EaF4004FB0dD31e8",
    },
    donationsTreasuryMultisig: {
      default: 4,
      // TODO: Update multisig addresses
      matsnet: "0x6e80164ea60673d64d5d6228beb684a1274bb017", // testertesting.eth
    },
    storeTreasuryMultisig: {
      default: 5,
      matsnet: "0x6e80164ea60673d64d5d6228beb684a1274bb017", // testertesting.eth
    },
    storeManager: {
      default: 6,
      matsnet: "0x6e80164ea60673d64d5d6228beb684a1274bb017", // testertesting.eth
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    // TODO: Temporary fix. Set to true once contract size is within limits.
    strict: false,
  },
  gasReporter: {
    enabled: true,
  },
}

export default config
