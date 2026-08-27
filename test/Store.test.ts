import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ContractTransactionResponse, type Signature } from "ethers"
import { to1e18 } from "@keep-network/hardhat-helpers/dist/number"
import { Store, MockERC20WithPermit } from "../typechain"

import deployPortal from "./fixtures/deployPortal"
import signTokenPermit from "./helpers/signTokenPermit"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const MAX_UINT16 = 2 ** 16 - 1 // 65535

describe("Store", () => {
  let mUSD: MockERC20WithPermit
  let store: Store
  let governance: HardhatEthersSigner
  let storeManager: HardhatEthersSigner
  let storeTreasuryMultisig: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let userOne: HardhatEthersSigner
  let userTwo: HardhatEthersSigner

  const productOneId = 1001
  const productOnePrice = to1e18("149")
  const productOneStock = 100
  const productOnePerCustomerLimit = 1

  const productTwoId = 1002
  const productTwoPrice = to1e18("399")
  const productTwoStock = 200

  before(async () => {
    ;({ governance, storeManager, storeTreasuryMultisig } =
      await helpers.signers.getNamedSigners())
    ;({
      mUSD,
      store,
      thirdParty,
      depositorOne: userOne,
      depositorTwo: userTwo,
    } = await loadFixture(deployPortal))

    await store
      .connect(storeManager)
      .updateProductPrice(productOneId, productOnePrice)
    await store
      .connect(storeManager)
      .updateProductStock(productOneId, productOneStock)
    await store
      .connect(storeManager)
      .updateProductPerCustomerLimit(productOneId, productOnePerCustomerLimit)

    await store
      .connect(storeManager)
      .updateProductPrice(productTwoId, productTwoPrice)
    await store
      .connect(storeManager)
      .updateProductStock(productTwoId, productTwoStock)
  })

  describe("updateStoreTreasury", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          store.connect(thirdParty).updateStoreTreasury(thirdParty.address),
        ).to.be.revertedWithCustomError(store, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the store manager", () => {
      it("should update the store treasury", async () => {
        await expect(
          store.connect(storeManager).updateStoreTreasury(thirdParty.address),
        ).to.be.revertedWithCustomError(store, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the governance", () => {
      context("with zero address", () => {
        it("should revert", async () => {
          await expect(
            store.connect(governance).updateStoreTreasury(ethers.ZeroAddress),
          ).to.be.revertedWithCustomError(store, "StoreTreasuryZeroAddress")
        })
      })

      context("with a valid address", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await store
            .connect(governance)
            .updateStoreTreasury(thirdParty.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the store treasury", async () => {
          expect(await store.storeTreasury()).to.equal(thirdParty.address)
        })

        it("should emit StoreTreasuryUpdated event", async () => {
          await expect(tx)
            .to.emit(store, "StoreTreasuryUpdated")
            .withArgs(thirdParty.address)
        })
      })
    })
  })

  describe("updateStoreManager", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          store.connect(thirdParty).updateStoreManager(thirdParty.address),
        ).to.be.revertedWithCustomError(store, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the store manager", () => {
      it("should revert", async () => {
        await expect(
          store.connect(storeManager).updateStoreManager(thirdParty.address),
        ).to.be.revertedWithCustomError(store, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the governance", () => {
      context("with zero address", () => {
        it("should revert", async () => {
          await expect(
            store.connect(governance).updateStoreManager(ethers.ZeroAddress),
          ).to.be.revertedWithCustomError(store, "StoreManagerZeroAddress")
        })
      })

      context("with a valid address", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await store
            .connect(governance)
            .updateStoreManager(thirdParty.address)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the store manager", async () => {
          expect(await store.storeManager()).to.equal(thirdParty.address)
        })

        it("should emit StoreManagerUpdated event", async () => {
          await expect(tx)
            .to.emit(store, "StoreManagerUpdated")
            .withArgs(thirdParty.address)
        })
      })
    })
  })

  describe("updateProductPrice", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          store
            .connect(thirdParty)
            .updateProductPrice(productOneId, productOnePrice),
        ).to.be.revertedWithCustomError(store, "CallerNotStoreManagerOrOwner")
      })
    })

    context("when called by the store manager", () => {
      const newProductPrice = to1e18("701")

      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(storeManager)
          .updateProductPrice(productOneId, newProductPrice)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product price", async () => {
        expect((await store.getProductDetails(productOneId)).price).to.equal(
          newProductPrice,
        )
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductPriceUpdated")
          .withArgs(productOneId, newProductPrice)
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(governance)
          .updateProductPrice(productOneId, productOnePrice)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product price", async () => {
        expect((await store.getProductDetails(productOneId)).price).to.equal(
          productOnePrice,
        )
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductPriceUpdated")
          .withArgs(productOneId, productOnePrice)
      })
    })

    context("when new price is zero", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await store.connect(storeManager).updateProductPrice(productOneId, 0)

        expect((await store.getProductDetails(productOneId)).price).to.equal(0)
      })
    })
  })

  describe("updateProductStock", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          store.connect(thirdParty).updateProductStock(productOneId, 100),
        ).to.be.revertedWithCustomError(store, "CallerNotStoreManagerOrOwner")
      })
    })

    context("when called by the store manager", () => {
      const newProductStock = 100

      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(storeManager)
          .updateProductStock(productOneId, newProductStock)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product stock", async () => {
        expect((await store.getProductDetails(productOneId)).stock).to.equal(
          newProductStock,
        )
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductStockUpdated")
          .withArgs(productOneId, newProductStock)
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(governance)
          .updateProductStock(productOneId, 100)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product stock", async () => {
        expect((await store.getProductDetails(productOneId)).stock).to.equal(
          100,
        )
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductStockUpdated")
          .withArgs(productOneId, 100)
      })
    })

    context("when new stock is zero", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await store.connect(storeManager).updateProductStock(productOneId, 0)

        expect((await store.getProductDetails(productOneId)).stock).to.equal(0)
      })
    })
  })

  describe("updateProductPerCustomerLimit", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          store
            .connect(thirdParty)
            .updateProductPerCustomerLimit(productOneId, 100),
        ).to.be.revertedWithCustomError(store, "CallerNotStoreManagerOrOwner")
      })
    })

    context("when called by the store manager", () => {
      const newProductPerCustomerLimit = 100

      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(storeManager)
          .updateProductPerCustomerLimit(
            productOneId,
            newProductPerCustomerLimit,
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product per customer limit", async () => {
        expect(
          (await store.getProductDetails(productOneId)).perCustomerLimit,
        ).to.equal(newProductPerCustomerLimit)
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductPerCustomerLimitUpdated")
          .withArgs(productOneId, newProductPerCustomerLimit)
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await store
          .connect(governance)
          .updateProductPerCustomerLimit(productOneId, 100)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should update the product per customer limit", async () => {
        expect(
          (await store.getProductDetails(productOneId)).perCustomerLimit,
        ).to.equal(100)
      })

      it("should emit ProductPriceUpdated event", async () => {
        await expect(tx)
          .to.emit(store, "ProductPerCustomerLimitUpdated")
          .withArgs(productOneId, 100)
      })
    })

    context("when new per customer limit is zero", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should succeed", async () => {
        await store
          .connect(storeManager)
          .updateProductPerCustomerLimit(productOneId, 0)

        expect(
          (await store.getProductDetails(productOneId)).perCustomerLimit,
        ).to.equal(0)
      })
    })
  })

  describe("order", () => {
    context("when the product is unknown", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          store.connect(userOne).order(9999),
        ).to.be.revertedWithCustomError(store, "UnknownProduct")
      })
    })

    context("when the product price is zero", () => {
      beforeEach(async () => {
        await createSnapshot()

        await store.connect(storeManager).updateProductPrice(productOneId, 0)
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          store.connect(userOne).order(productOneId),
        ).to.be.revertedWithCustomError(store, "UnknownProduct")
      })
    })

    context(
      "when the product is available for purchase with limited stock",
      () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await mUSD
            .connect(userOne)
            .approve(await store.getAddress(), productOnePrice)

          tx = await store.connect(userOne).order(productOneId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should register an order", async () => {
          const orders = await store.getOrders(userOne.address, productOneId)

          expect(orders.length).to.equal(1)
          expect(orders[0].orderId).to.equal(1)
          expect(orders[0].productId).to.equal(productOneId)
          expect(orders[0].price).to.equal(productOnePrice)
        })

        it("should decrement the product stock", async () => {
          expect((await store.getProductDetails(productOneId)).stock).to.equal(
            productOneStock - 1,
          )
        })

        it("should emit OrderPlaced event", async () => {
          await expect(tx)
            .to.emit(store, "OrderPlaced")
            .withArgs(1, userOne.address, productOneId, productOnePrice)
        })

        it("should transfer the payment to the store treasury", async () => {
          expect(tx).to.changeTokenBalance(
            mUSD,
            [userOne.address, storeTreasuryMultisig],
            [-productOnePrice, productOnePrice],
          )
        })
      },
    )

    context(
      "when the product is available for purchase with unlimited stock",
      () => {
        before(async () => {
          await createSnapshot()

          await store
            .connect(storeManager)
            .updateProductStock(productOneId, MAX_UINT16)

          await mUSD
            .connect(userOne)
            .approve(await store.getAddress(), productOnePrice)

          await store.connect(userOne).order(productOneId)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should register an order", async () => {
          const orders = await store.getOrders(userOne.address, productOneId)

          expect(orders.length).to.equal(1)
          expect(orders[0].orderId).to.equal(1)
          expect(orders[0].productId).to.equal(productOneId)
          expect(orders[0].price).to.equal(productOnePrice)
        })

        it("shouldn't change the product stock", async () => {
          expect((await store.getProductDetails(productOneId)).stock).to.equal(
            MAX_UINT16,
          )
        })
      },
    )

    context("when the product is out of stock", () => {
      before(async () => {
        await createSnapshot()

        await store.connect(storeManager).updateProductStock(productOneId, 0)

        await mUSD
          .connect(userOne)
          .approve(await store.getAddress(), productOnePrice)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          store.connect(userOne).order(productOneId),
        ).to.be.revertedWithCustomError(store, "ProductOutOfStock")
      })
    })

    context("when one user orders the same product multiple times", () => {
      let tx1: ContractTransactionResponse
      let tx2: ContractTransactionResponse
      before(async () => {
        await createSnapshot()

        await store
          .connect(storeManager)
          .updateProductPerCustomerLimit(productOneId, 2)

        await mUSD
          .connect(userOne)
          .approve(await store.getAddress(), productOnePrice * 3n)

        // Buy first item
        tx1 = await store.connect(userOne).order(productOneId)

        // Buy second item
        tx2 = await store.connect(userOne).order(productOneId)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should register multiple orders", async () => {
        const orders = await store.getOrders(userOne.address, productOneId)

        expect(orders.length).to.equal(2)

        expect(orders[0].orderId).to.equal(1)
        expect(orders[0].productId).to.equal(productOneId)
        expect(orders[0].price).to.equal(productOnePrice)

        expect(orders[1].orderId).to.equal(2)
        expect(orders[1].productId).to.equal(productOneId)
        expect(orders[1].price).to.equal(productOnePrice)
      })

      it("should decrement the product stock", async () => {
        expect((await store.getProductDetails(productOneId)).stock).to.equal(
          productOneStock - 2,
        )
      })

      it("should emit OrderPlaced event", async () => {
        await expect(tx1)
          .to.emit(store, "OrderPlaced")
          .withArgs(1, userOne.address, productOneId, productOnePrice)
      })

      it("should emit OrderPlaced event", async () => {
        await expect(tx2)
          .to.emit(store, "OrderPlaced")
          .withArgs(2, userOne.address, productOneId, productOnePrice)
      })

      it("should transfer the payment to the store treasury", async () => {
        expect(tx1).to.changeTokenBalance(
          mUSD,
          [userOne.address, storeTreasuryMultisig],
          [-productOnePrice, productOnePrice],
        )

        expect(tx2).to.changeTokenBalance(
          mUSD,
          [userOne.address, storeTreasuryMultisig],
          [-productOnePrice, productOnePrice],
        )
      })

      context("when the product per customer limit is reached", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert for the same product", async () => {
          await expect(
            store.connect(userOne).order(productOneId),
          ).to.be.revertedWithCustomError(
            store,
            "ProductPerCustomerLimitReached",
          )
        })

        it("should succeed for different product", async () => {
          await mUSD
            .connect(userOne)
            .approve(await store.getAddress(), productTwoPrice)

          await store.connect(userOne).order(productTwoId)
        })
      })
    })

    context("when two users order the same product", () => {
      let tx1: ContractTransactionResponse
      let tx2: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await store
          .connect(storeManager)
          .updateProductPerCustomerLimit(productOneId, 1)

        await mUSD
          .connect(userOne)
          .approve(await store.getAddress(), productOnePrice)

        tx1 = await store.connect(userOne).order(productOneId)

        await mUSD
          .connect(userTwo)
          .approve(await store.getAddress(), productOnePrice)

        tx2 = await store.connect(userTwo).order(productOneId)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should register two orders", async () => {
        const orders1 = await store.getOrders(userOne.address, productOneId)
        const orders2 = await store.getOrders(userTwo.address, productOneId)

        expect(orders1.length).to.equal(1)
        expect(orders2.length).to.equal(1)

        expect(orders1[0].orderId).to.equal(1)
        expect(orders1[0].productId).to.equal(productOneId)
        expect(orders1[0].price).to.equal(productOnePrice)

        expect(orders2[0].orderId).to.equal(2)
        expect(orders2[0].productId).to.equal(productOneId)
        expect(orders2[0].price).to.equal(productOnePrice)
      })

      it("should decrement the product stock", async () => {
        expect((await store.getProductDetails(productOneId)).stock).to.equal(
          productOneStock - 2,
        )
      })

      it("should emit OrderPlaced event", async () => {
        await expect(tx1)
          .to.emit(store, "OrderPlaced")
          .withArgs(1, userOne.address, productOneId, productOnePrice)

        await expect(tx2)
          .to.emit(store, "OrderPlaced")
          .withArgs(2, userTwo.address, productOneId, productOnePrice)
      })

      it("should transfer the payment to the store treasury", async () => {
        expect(tx1).to.changeTokenBalance(
          mUSD,
          [userOne.address, storeTreasuryMultisig],
          [-productOnePrice, productOnePrice],
        )

        expect(tx2).to.changeTokenBalance(
          mUSD,
          [userTwo.address, storeTreasuryMultisig],
          [-productOnePrice, productOnePrice],
        )
      })
    })

    context("when two users order different products", () => {
      let tx1: ContractTransactionResponse
      let tx2: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await mUSD
          .connect(userOne)
          .approve(await store.getAddress(), productOnePrice)

        await mUSD
          .connect(userTwo)
          .approve(await store.getAddress(), productTwoPrice)

        tx1 = await store.connect(userOne).order(productOneId)
        tx2 = await store.connect(userTwo).order(productTwoId)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should register two orders", async () => {
        const orders1 = await store.getOrders(userOne.address, productOneId)
        const orders2 = await store.getOrders(userTwo.address, productTwoId)

        expect(orders1.length).to.equal(1)
        expect(orders2.length).to.equal(1)

        expect(orders1[0].orderId).to.equal(1)
        expect(orders1[0].productId).to.equal(productOneId)
        expect(orders1[0].price).to.equal(productOnePrice)

        expect(orders2[0].orderId).to.equal(2)
        expect(orders2[0].productId).to.equal(productTwoId)
        expect(orders2[0].price).to.equal(productTwoPrice)
      })

      it("should decrement the product stock", async () => {
        expect((await store.getProductDetails(productOneId)).stock).to.equal(
          productOneStock - 1,
        )

        expect((await store.getProductDetails(productTwoId)).stock).to.equal(
          productTwoStock - 1,
        )
      })

      it("should emit OrderPlaced event", async () => {
        await expect(tx1)
          .to.emit(store, "OrderPlaced")
          .withArgs(1, userOne.address, productOneId, productOnePrice)

        await expect(tx2)
          .to.emit(store, "OrderPlaced")
          .withArgs(2, userTwo.address, productTwoId, productTwoPrice)
      })

      it("should transfer the payment to the store treasury", async () => {
        expect(tx1).to.changeTokenBalance(
          mUSD,
          [userOne.address, storeTreasuryMultisig],
          [-productOnePrice, productOnePrice],
        )

        expect(tx2).to.changeTokenBalance(
          mUSD,
          [userTwo.address, storeTreasuryMultisig],
          [-productTwoPrice, productTwoPrice],
        )
      })
    })
  })

  describe("orderWithPermit", () => {
    let deadline: bigint
    let signature: Signature

    before(async () => {
      await createSnapshot()

      deadline = BigInt((await helpers.time.lastBlockTime()) + 3600)

      signature = await signTokenPermit(
        mUSD,
        userOne,
        await store.getAddress(),
        productOnePrice,
        deadline,
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called by a third-party", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          store
            .connect(thirdParty)
            .orderWithPermit(
              productOneId,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            ),
        ).to.be.revertedWithCustomError(mUSD, "ERC20InsufficientAllowance")
      })

      context("when called by the user", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await store
            .connect(userOne)
            .orderWithPermit(
              productOneId,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should register an order", async () => {
          const orders = await store.getOrders(userOne.address, productOneId)

          expect(orders.length).to.equal(1)
          expect(orders[0].orderId).to.equal(1)
          expect(orders[0].productId).to.equal(productOneId)
          expect(orders[0].price).to.equal(productOnePrice)
        })

        it("should decrement the product stock", async () => {
          expect((await store.getProductDetails(productOneId)).stock).to.equal(
            productOneStock - 1,
          )
        })

        it("should emit OrderPlaced event", async () => {
          await expect(tx)
            .to.emit(store, "OrderPlaced")
            .withArgs(1, userOne.address, productOneId, productOnePrice)
        })

        it("should transfer the payment to the store treasury", async () => {
          expect(tx).to.changeTokenBalance(
            mUSD,
            [userOne.address, storeTreasuryMultisig],
            [-productOnePrice, productOnePrice],
          )
        })
      })
    })
  })
})
