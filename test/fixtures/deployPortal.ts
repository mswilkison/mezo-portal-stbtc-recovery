import {
  deployments,
  ethers,
  getNamedAccounts,
  getUnnamedAccounts,
  helpers,
} from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { MaxInt256 } from "ethers"
import {
  MezoBridge,
  BitcoinDepositor,
  Portal,
  MockERC20,
  MockERC20WithPermit,
  MockBridge,
  MockTBTCVault,
  MockSTBTC,
  MockWBTC,
  MockERC20WithoutDecimals,
  MatsnetStore,
  Donations,
  Store,
} from "../../typechain"
import { TokenAbility } from "../../types"

export default async function deployPortal(): Promise<{
  TBTC: MockERC20
  WBTC: MockWBTC
  USDC: MockERC20
  stBTC: MockSTBTC
  OTHER: MockERC20
  mUSD: MockERC20WithPermit
  TokenWithoutDecimals: MockERC20WithoutDecimals
  tbtcAddress: string
  wbtcAddress: string
  usdcAddress: string
  stbtcAddress: string
  otherAddress: string
  musdAddress: string
  tokenWithoutDecimalsAddress: string
  portal: Portal
  bitcoinDepositor: BitcoinDepositor
  mezoBridge: MezoBridge
  tbtcBridge: MockBridge
  tbtcVault: MockTBTCVault
  matsnetStore: MatsnetStore
  donations: Donations
  store: Store
  deployer: HardhatEthersSigner
  thirdParty: HardhatEthersSigner
  depositorOne: HardhatEthersSigner
  depositorTwo: HardhatEthersSigner
  depositorThree: HardhatEthersSigner
  liquidityTreasuryMultisig: HardhatEthersSigner
  tbtcMigrationTreasuryMultisig: HardhatEthersSigner
  autoBridgeCoordinator: HardhatEthersSigner
  tokenAbility: typeof TokenAbility
}> {
  const { deployer, liquidityTreasuryMultisig, tbtcMigrationTreasuryMultisig } =
    await getNamedAccounts()

  const [
    thirdParty,
    depositorOne,
    depositorTwo,
    depositorThree,
    autoBridgeCoordinator,
  ] = await getUnnamedAccounts()

  await deployments.fixture()

  await deployments.deploy("MockUSDC", {
    contract: "MockERC20",
    from: deployer,
    args: ["MockUSDC", "MockUSDC", ethers.parseEther("100")],
    log: true,
    waitConfirmations: 1,
  })

  await deployments.deploy("MockSTBTC", {
    contract: "MockSTBTC",
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  // MockOTHER is meant to never be used as a supported token
  await deployments.deploy("MockOTHER", {
    contract: "MockERC20",
    from: deployer,
    args: ["MockOTHER", "MockOTHER", ethers.parseEther("100")],
    log: true,
    waitConfirmations: 1,
  })

  await deployments.deploy("MockWithoutDecimals", {
    contract: "MockERC20WithoutDecimals",
    from: deployer,
    log: true,
    waitConfirmations: 1,
  })

  const TBTC = (await helpers.contracts.getContract(
    "TBTC",
  )) as unknown as MockERC20

  const WBTC = (await helpers.contracts.getContract(
    "WBTC",
  )) as unknown as MockWBTC

  const USDC = (await helpers.contracts.getContract(
    "MockUSDC",
  )) as unknown as MockERC20

  const stBTC = (await helpers.contracts.getContract(
    "MockSTBTC",
  )) as unknown as MockSTBTC

  const OTHER = (await helpers.contracts.getContract(
    "MockOTHER",
  )) as unknown as MockERC20

  const TokenWithoutDecimals = (await helpers.contracts.getContract(
    "MockWithoutDecimals",
  )) as unknown as MockERC20

  const portal = (await helpers.contracts.getContract(
    "Portal",
  )) as unknown as Portal

  const bitcoinDepositor = (await helpers.contracts.getContract(
    "BitcoinDepositor",
  )) as unknown as BitcoinDepositor

  const mezoBridge = (await helpers.contracts.getContract(
    "MezoBridge",
  )) as unknown as MezoBridge

  const tbtcBridge = (await helpers.contracts.getContract(
    "Bridge",
  )) as unknown as MockBridge

  const tbtcVault = (await helpers.contracts.getContract(
    "TBTCVault",
  )) as unknown as MockTBTCVault

  const mUSD = (await helpers.contracts.getContract(
    "MUSD",
  )) as unknown as MockERC20WithPermit

  const matsnetStore = (await helpers.contracts.getContract(
    "MatsnetStore",
  )) as unknown as MatsnetStore

  const donations = (await helpers.contracts.getContract(
    "Donations",
  )) as unknown as Donations

  const store = (await helpers.contracts.getContract(
    "Store",
  )) as unknown as Store

  await Promise.all(
    [thirdParty, depositorOne, depositorTwo, depositorThree].map(
      async (address) => {
        await TBTC.transfer(address, ethers.parseEther("10"))
        await WBTC.transfer(address, ethers.parseEther("10"))
        await USDC.transfer(address, ethers.parseEther("10"))
        await OTHER.transfer(address, ethers.parseEther("10"))
        await mUSD.transfer(address, ethers.parseEther("1000"))
      },
    ),
  )

  await TBTC.transfer(tbtcMigrationTreasuryMultisig, ethers.parseEther("50"))

  const tbtcAddress = await TBTC.getAddress()
  const wbtcAddress = await WBTC.getAddress()
  const usdcAddress = await USDC.getAddress()
  const stbtcAddress = await stBTC.getAddress()
  const otherAddress = await OTHER.getAddress()
  const tokenWithoutDecimalsAddress = await TokenWithoutDecimals.getAddress()
  const musdAddress = await mUSD.getAddress()

  // We do it at the very end of the fixture setup process, once all initial
  // mint and token allocation operations already happened. On testnet and
  // mainnet, tBTC token contract is already owned by the vault.
  await TBTC.transferOwnership(await tbtcVault.getAddress())

  await stBTC.updateDebtAllowance(await portal.getAddress(), MaxInt256)

  await portal.setLiquidityTreasury(liquidityTreasuryMultisig)

  await portal.setTbtcMigrationTreasury(tbtcMigrationTreasuryMultisig)

  await portal.setAutoBridgeCoordinator(autoBridgeCoordinator)

  return {
    TBTC,
    WBTC,
    USDC,
    stBTC,
    OTHER,
    mUSD,
    TokenWithoutDecimals,
    tbtcAddress,
    wbtcAddress,
    usdcAddress,
    stbtcAddress,
    otherAddress,
    musdAddress,
    tokenWithoutDecimalsAddress,
    portal,
    bitcoinDepositor,
    mezoBridge,
    tbtcBridge,
    tbtcVault,
    matsnetStore,
    donations,
    store,
    deployer: await ethers.getSigner(deployer),
    thirdParty: await ethers.getSigner(thirdParty),
    depositorOne: await ethers.getSigner(depositorOne),
    depositorTwo: await ethers.getSigner(depositorTwo),
    depositorThree: await ethers.getSigner(depositorThree),
    liquidityTreasuryMultisig: await ethers.getSigner(
      liquidityTreasuryMultisig,
    ),
    tbtcMigrationTreasuryMultisig: await ethers.getSigner(
      tbtcMigrationTreasuryMultisig,
    ),
    autoBridgeCoordinator: await ethers.getSigner(autoBridgeCoordinator),
    tokenAbility: TokenAbility,
  }
}
