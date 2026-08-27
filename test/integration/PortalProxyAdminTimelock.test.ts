import { ethers, helpers, upgrades } from "hardhat"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { createSnapshot } from "@keep-network/hardhat-helpers/dist/snapshot"
import { Interface } from "ethers"
import deployPortal from "../fixtures/deployPortal"
import { Portal, Timelock } from "../../typechain"

// A basic set of integration tests demonstrating how to use the Timelock with
// Portal ProxyAdmin. The goal is not to test OpenZeppelin implementation but
// to prove the integration works and how the transactions should be assembled.
describe("Integration tests - Timelock", () => {
  let portal: Portal
  let timelock: Timelock
  let proxyAdmin: Interface

  let tbtcAddress: string
  let portalAddress: string
  let proxyAdminAddress: string
  let timelockAddress: string

  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let governanceSigner: HardhatEthersSigner

  const zeroBytes = "0x"

  const zeroBytes32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000"

  const timelockDelay = 86400 // 24h governance delay

  before(async () => {
    ;({ portal, deployer, thirdParty, tbtcAddress } =
      await loadFixture(deployPortal))

    // Mezo multisig
    ;({ governance } = await helpers.signers.getNamedSigners())

    // One of the Mezo multisig signers
    governanceSigner = await helpers.account.impersonateAccount(
      "0x696BA87e3Ef864335A9E30Ae4653b516Fb93a1AB",
      {
        from: deployer,
        value: 10n,
      },
    )

    timelock = (await helpers.contracts.getContract(
      "PortalProxyAdminTimelock",
    )) as unknown as Timelock

    portalAddress = await portal.getAddress()
    proxyAdminAddress = await upgrades.erc1967.getAdminAddress(portalAddress)
    timelockAddress = await timelock.getAddress()

    proxyAdmin = new ethers.Interface([
      "function upgradeAndCall(address proxy, address implementation, bytes data) payable",
    ])

    // Transfer Portal ProxyAdmin contract ownership to the Timelock contract.
    await upgrades.admin.transferProxyAdminOwnership(
      portalAddress,
      timelockAddress,
      governance,
    )
  })

  context("when upgrading Portal implementation via Timelock", async () => {
    let expectedNewImplementation: string

    before(async () => {
      await createSnapshot()

      // We need an existing contract. Otherwise, ProxyAdmin.upgradeAndCall
      // will revert. Obviously, in a real world, it does not make sense to
      // upgrade Portal implementation address to point to tBTC contract but
      // we just want to confirm switching the implementation address works.
      expectedNewImplementation = tbtcAddress

      const data = proxyAdmin.encodeFunctionData("upgradeAndCall", [
        portalAddress,
        tbtcAddress,
        zeroBytes,
      ])

      await timelock
        .connect(governance)
        .schedule(
          proxyAdminAddress,
          0,
          data,
          zeroBytes32,
          zeroBytes32,
          timelockDelay,
        )
      await helpers.time.increaseTime(timelockDelay)
      await timelock
        .connect(governanceSigner)
        .execute(proxyAdminAddress, 0, data, zeroBytes32, zeroBytes32)
    })

    after(async () => {
      await createSnapshot()
    })

    it("should switch the implementation address", async () => {
      const newImplementation =
        await upgrades.erc1967.getImplementationAddress(portalAddress)

      expect(newImplementation).to.equal(expectedNewImplementation)
    })
  })

  context("when third party tries to schedule upgrade", () => {
    it("should revet", async () => {
      const data = proxyAdmin.encodeFunctionData("upgradeAndCall", [
        portalAddress,
        tbtcAddress,
        zeroBytes,
      ])

      await expect(
        timelock
          .connect(thirdParty)
          .schedule(
            proxyAdminAddress,
            0,
            data,
            zeroBytes32,
            zeroBytes32,
            timelockDelay,
          ),
      ).to.be.revertedWithCustomError(
        timelock,
        "AccessControlUnauthorizedAccount",
      )
    })
  })
})
