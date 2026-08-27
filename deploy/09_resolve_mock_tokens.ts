import { ethers } from "hardhat"
import { DeployFunction } from "hardhat-deploy/dist/types"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { Portal } from "../typechain"
import { TokenAbility } from "../types"

const resolveMockToken = async (
  hre: HardhatRuntimeEnvironment,
  portalContract: Portal,
  options: {
    name: string
    contract: string
    args: unknown[]
  },
  forceDeployment = false,
) => {
  const { deployments, helpers, getNamedAccounts, network } = hre
  const { log } = deployments

  if (!forceDeployment && network.name !== "hardhat") {
    log("Skipping mock token deployment on non-hardhat network")

    return
  }

  const { deployer } = await getNamedAccounts()
  const { name, contract, args } = options

  const token = await deployments.getOrNull(name)

  const isValidDeployment = token && helpers.address.isValid(token.address)

  if (isValidDeployment) {
    log(`Using ${name} at ${token.address}`)
    return
  }

  const deployedToken = await deployments.deploy(name, {
    contract,
    from: deployer,
    args,
    log: true,
    waitConfirmations: 1,
  })

  const tx = await portalContract.addSupportedToken({
    token: deployedToken.address,
    tokenAbility: TokenAbility.DepositAndLock,
  })

  await tx.wait()

  log(`Added ${name} as supported token to Portal.\n`)
}

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const portalAddress = (await hre.deployments.get("Portal")).address
  const portalContract = await ethers.getContractAt("Portal", portalAddress)

  await resolveMockToken(hre, portalContract, {
    name: "thUSD",
    contract: "MockERC20",
    args: ["thUSD", "thUSD", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "USDe",
    contract: "MockERC20",
    args: ["USDe", "USDe", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "crvUSD",
    contract: "MockERC20",
    args: ["crvUSD", "crvUSD", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "DAI",
    contract: "MockERC20",
    args: ["DAI", "DAI", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "USDC",
    contract: "MockERC20",
    args: ["USDC", "USDC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "USDT",
    contract: "MockERC20",
    args: ["USDT", "USDT", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "fBTC",
    contract: "MockERC20With8Decimals",
    args: ["fBTC", "fBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "SolvBTC",
    contract: "MockERC20",
    args: ["SolvBTC", "SolvBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "SolvBTC.BBN",
    contract: "MockERC20",
    args: ["SolvBTC.BBN", "SolvBTC.BBN", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "crv-stBTC",
    contract: "MockERC20",
    args: ["crv-stBTC", "crv-stBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "swBTC",
    contract: "MockERC20With8Decimals",
    args: ["swBTC", "swBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "cbBTC",
    contract: "MockERC20With8Decimals",
    args: ["cbBTC", "cbBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "LBTC",
    contract: "MockERC20With8Decimals",
    args: ["LBTC", "LBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "aBTC",
    contract: "MockERC20",
    args: ["aBTC", "aBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "intBTC",
    contract: "MockERC20",
    args: ["intBTC", "intBTC", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "wM",
    contract: "MockERC20With6Decimals",
    args: ["wM", "wM", ethers.parseEther("100")],
  })

  await resolveMockToken(hre, portalContract, {
    name: "T",
    contract: "MockERC20",
    args: ["T", "T", ethers.parseEther("100")],
  })
}

export default func

func.tags = ["ResolveMockTokens"]
func.dependencies = ["Portal"]

func.skip = async (hre) => hre.network.name !== "hardhat"
