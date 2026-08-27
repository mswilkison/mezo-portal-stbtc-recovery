import { ethers, upgrades } from "hardhat"

const describeFn =
  process.env.NODE_ENV === "upgrades-test" ? describe : describe.skip

describeFn("Portal - upgrade tests", () => {
  it("should be able to upgrade the current mainnet version", async () => {
    const Portal = await ethers.getContractFactory("Portal")
    await upgrades.validateUpgrade(
      "0xAB13B8eecf5AA2460841d75da5d5D861fD5B8A39",
      Portal,
    )
  })
})
