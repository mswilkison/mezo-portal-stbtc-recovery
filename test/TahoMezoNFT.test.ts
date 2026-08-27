import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { ethers, getNamedAccounts, helpers } from "hardhat"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { toUtf8Bytes } from "ethers"
import { MockERC20, MockTroveManager, TahoMezoNFT } from "../typechain"

import deployPortal from "./fixtures/deployPortal"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const encodeMintParameters = (installId: string, address: string) => {
  const data = ethers.solidityPacked(
    ["string", "address"],
    [installId, address],
  )

  return ethers.getBytes(data)
}

describe("TahoMezoNFT", () => {
  let mUSD: MockERC20
  let troveManager: MockTroveManager
  let tahoMezoNFT: TahoMezoNFT
  let userOne: HardhatEthersSigner
  let userTwo: HardhatEthersSigner

  before(async () => {
    ;({
      mUSD,
      depositorOne: userOne,
      depositorTwo: userTwo,
    } = await loadFixture(deployPortal))

    troveManager = (await helpers.contracts.getContract(
      "MockTroveManager",
    )) as unknown as MockTroveManager

    tahoMezoNFT = (await helpers.contracts.getContract(
      "TahoMezoNFT",
    )) as unknown as TahoMezoNFT

    await mUSD
      .connect(userOne)
      .approve(await tahoMezoNFT.getAddress(), ethers.parseEther("100"))
    await mUSD
      .connect(userTwo)
      .approve(await tahoMezoNFT.getAddress(), ethers.parseEther("100"))
  })

  describe("Minting", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should emit a Mint event", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      const tx = await tahoMezoNFT
        .connect(userOne)
        .mint(
          "some-install-id",
          await owner.signMessage(
            encodeMintParameters("some-install-id", userOne.address),
          ),
        )

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(true)

      expect(tx)
        .to.emit(tahoMezoNFT, "Mint")
        .withArgs(userOne.address, "some-install-id")
    })

    it("cannot claim more than once per install id", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      await tahoMezoNFT
        .connect(userOne)
        .mint(
          "some-install-id",
          await owner.signMessage(
            encodeMintParameters("some-install-id", userOne.address),
          ),
        )

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(true)

      await expect(
        tahoMezoNFT
          .connect(userTwo)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "AlreadyClaimed")
    })

    it("cannot claim without an active borrow", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 0)

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "MissingBorrowRequirement")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })

    it("cannot claim using a signature meant for another address", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 0)

      await expect(
        tahoMezoNFT
          .connect(userTwo)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "InvalidSignature")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })

    it("cannot claim without a signature matching install Id", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-other-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "InvalidSignature")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })

    it("cannot claim without a valid signature from verifier", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      expect(await tahoMezoNFT.verifier()).to.not.eq(userOne)

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "some-install-id",
            await userOne.signMessage("some-invalid-signature"),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "InvalidSignature")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })

    it("cannot claim with a valid signature from previous verifier", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      expect(await tahoMezoNFT.verifier()).to.eq(owner)

      expect(await tahoMezoNFT.setVerifier(userTwo))

      expect(await tahoMezoNFT.verifier()).to.eq(userTwo)

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-invalid-signature", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "InvalidSignature")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })

    it("cannot claim more than once per address", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      await tahoMezoNFT
        .connect(userOne)
        .mint(
          "some-install-id",
          await owner.signMessage(
            encodeMintParameters("some-install-id", userOne.address),
          ),
        )

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "another-install-id",
            await owner.signMessage(
              encodeMintParameters("another-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(tahoMezoNFT, "MaxTokensPerAddress")

      expect(await tahoMezoNFT.claimedIds("another-install-id")).to.eq(false)
    })

    it("cannot claim without enough token funds", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)

      await mUSD
        .connect(userOne)
        .transfer(userTwo, await mUSD.balanceOf(userOne))

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .mint(
            "some-install-id",
            await owner.signMessage(
              encodeMintParameters("some-install-id", userOne.address),
            ),
          ),
      ).to.revertedWithCustomError(mUSD, "ERC20InsufficientBalance")

      expect(await tahoMezoNFT.claimedIds("some-install-id")).to.eq(false)
    })
  })

  describe("Transferring", () => {
    beforeEach(async () => {
      await createSnapshot()
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("Cannot transfer if receiver already holds an NFT", async () => {
      const { deployer } = await getNamedAccounts()

      const owner = await ethers.getSigner(deployer)

      await troveManager.connect(owner).setDebt(userOne, 100)
      await troveManager.connect(owner).setDebt(userTwo, 100)

      await tahoMezoNFT
        .connect(userOne)
        .mint(
          "some-install-id",
          await owner.signMessage(
            encodeMintParameters("some-install-id", userOne.address),
          ),
        )

      await tahoMezoNFT
        .connect(userTwo)
        .mint(
          "some-install-id-2",
          await owner.signMessage(
            encodeMintParameters("some-install-id-2", userTwo.address),
          ),
        )

      await expect(
        tahoMezoNFT
          .connect(userOne)
          .safeTransferFrom(userOne, userTwo, 1, 1, toUtf8Bytes("")),
      ).to.revertedWithCustomError(tahoMezoNFT, "MaxTokensPerAddress")
    })
  })
})
