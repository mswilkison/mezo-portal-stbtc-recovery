import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ContractTransactionResponse } from "ethers"
import { MatsnetStore, MockERC20 } from "../typechain"

import deployPortal from "./fixtures/deployPortal"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("MatsnetStore", () => {
  let mUSD: MockERC20
  let matsnetStore: MatsnetStore
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let userOne: HardhatEthersSigner
  let userTwo: HardhatEthersSigner

  const productOneId = "dac103b5-e0eb-49fa-806e-34089acd63fe"
  const productOnePrice = ethers.parseEther("30")
  const productTwoId = "36919d71-344b-4887-86b3-5ce903968a87"
  const productTwoPrice = ethers.parseEther("70")

  before(async () => {
    ;({ governance } = await helpers.signers.getNamedSigners())
    ;({
      mUSD,
      matsnetStore,
      thirdParty,
      depositorOne: userOne,
      depositorTwo: userTwo,
    } = await loadFixture(deployPortal))

    await mUSD
      .connect(userOne)
      .approve(await matsnetStore.getAddress(), ethers.parseEther("100"))
    await mUSD
      .connect(userTwo)
      .approve(await matsnetStore.getAddress(), ethers.parseEther("100"))
  })

  describe("orderProduct", () => {
    context("when placing an order incorrectly", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert when the product is unknown", async () => {
        await expect(
          matsnetStore.connect(userOne).orderProduct("not-known"),
        ).to.be.revertedWithCustomError(matsnetStore, "UnknownProduct")
      })
    })

    context("when placing an order correctly", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should place an order", async () => {
        const userOneAddress = await userOne.getAddress()

        const order = {
          id: 1, // first order so expected ID is 1
          productId: productOneId,
          price: productOnePrice,
        }

        const userBalanceBefore = await mUSD.balanceOf(userOneAddress)

        const tx = await matsnetStore
          .connect(userOne)
          .orderProduct(order.productId)

        await expect(tx)
          .to.emit(matsnetStore, "OrderPlaced")
          .withArgs(userOneAddress, order.id, order.productId, order.price)

        const ordered = await matsnetStore.orders(userOneAddress, 0)

        expect(ordered.orderId).to.equal(order.id)
        expect(ordered.productId).to.equal(order.productId)
        expect(ordered.price).to.equal(order.price)

        expect(await mUSD.balanceOf(userOneAddress)).to.equal(
          userBalanceBefore - order.price,
        )
        expect(await mUSD.balanceOf(await matsnetStore.getAddress())).to.equal(
          order.price,
        )
      })
    })

    context("when placing two orders", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should place two orders", async () => {
        const userOneAddress = await userOne.getAddress()

        const orderOne = {
          id: 1, // first order so expected ID is 1
          productId: productOneId,
          price: productOnePrice,
        }

        const orderTwo = {
          id: 2, // second order so expected ID is 2
          productId: productTwoId,
          price: productTwoPrice,
        }

        const userBalanceBefore = await mUSD.balanceOf(userOneAddress)

        await matsnetStore.connect(userOne).orderProduct(orderOne.productId)

        await matsnetStore.connect(userOne).orderProduct(orderTwo.productId)

        const orderedFirst = await matsnetStore.orders(userOneAddress, 0)
        const orderedSecond = await matsnetStore.orders(userOneAddress, 1)

        expect(orderedFirst.orderId).to.equal(orderOne.id)
        expect(orderedFirst.productId).to.equal(orderOne.productId)
        expect(orderedFirst.price).to.equal(orderOne.price)
        expect(orderedSecond.orderId).to.equal(orderTwo.id)
        expect(orderedSecond.productId).to.equal(orderTwo.productId)
        expect(orderedSecond.price).to.equal(orderTwo.price)

        expect(await mUSD.balanceOf(userOneAddress)).to.equal(
          userBalanceBefore - orderOne.price - orderTwo.price,
        )
        expect(await mUSD.balanceOf(await matsnetStore.getAddress())).to.equal(
          orderOne.price + orderTwo.price,
        )
      })
    })

    context("when placing an order by more than one user", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should place an order by more than one user", async () => {
        const userOneAddress = await userOne.getAddress()
        const userTwoAddress = await userTwo.getAddress()

        const order = {
          id: 1, // first order so expected ID is 1
          productId: productOneId,
          price: productOnePrice,
        }

        const orderTwo = {
          id: 2, // second order so expected ID is 2
          productId: productTwoId,
          price: productTwoPrice,
        }

        const userOneBalanceBefore = await mUSD.balanceOf(userOneAddress)
        const userTwoBalanceBefore = await mUSD.balanceOf(userTwoAddress)

        await matsnetStore.connect(userOne).orderProduct(order.productId)

        await matsnetStore.connect(userTwo).orderProduct(orderTwo.productId)

        const userOneOrder = await matsnetStore.orders(userOneAddress, 0)
        expect(userOneOrder.orderId).to.equal(order.id)
        expect(userOneOrder.productId).to.equal(order.productId)
        expect(userOneOrder.price).to.equal(order.price)

        expect(await mUSD.balanceOf(userOneAddress)).to.equal(
          userOneBalanceBefore - order.price,
        )

        const userTwoOrder = await matsnetStore.orders(userTwoAddress, 0)
        expect(userTwoOrder.orderId).to.equal(orderTwo.id)
        expect(userTwoOrder.productId).to.equal(orderTwo.productId)
        expect(userTwoOrder.price).to.equal(orderTwo.price)

        expect(await mUSD.balanceOf(userTwoAddress)).to.equal(
          userTwoBalanceBefore - orderTwo.price,
        )

        expect(await mUSD.balanceOf(await matsnetStore.getAddress())).to.equal(
          order.price + orderTwo.price,
        )
      })
    })
  })

  describe("setProductPrice", () => {
    const productId = "my-product-id"
    const productPrice = 997

    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          matsnetStore
            .connect(thirdParty)
            .setProductPrice(productId, productPrice),
        ).to.be.revertedWithCustomError(
          matsnetStore,
          "OwnableUnauthorizedAccount",
        )
      })
    })

    context("when called by the governance", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await matsnetStore
          .connect(governance)
          .setProductPrice(productId, productPrice)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product price", async () => {
        expect(await matsnetStore.productPrice(productId)).to.equal(
          productPrice,
        )
      })

      it("should emit PriceUpdated event", async () => {
        await expect(tx)
          .to.emit(matsnetStore, "ProductPriceUpdated")
          .withArgs(productId, productPrice)
      })
    })
  })
})
