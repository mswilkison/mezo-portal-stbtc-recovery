import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { ethers, helpers } from "hardhat"
import { expect } from "chai"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { ContractTransactionResponse, type Signature } from "ethers"
import { Donations, MockERC20WithPermit } from "../typechain"

import deployPortal from "./fixtures/deployPortal"
import signTokenPermit from "./helpers/signTokenPermit"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Donations", () => {
  const beneficiaryId = "org-1"

  let mUSD: MockERC20WithPermit
  let donations: Donations
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let userOne: HardhatEthersSigner
  let userTwo: HardhatEthersSigner
  let recipient: string

  before(async () => {
    ;({ governance } = await helpers.signers.getNamedSigners())
    ;({
      mUSD,
      donations,
      thirdParty,
      depositorOne: userOne,
      depositorTwo: userTwo,
    } = await loadFixture(deployPortal))

    recipient = ethers.Wallet.createRandom().address
  })

  describe("updateBeneficiary", () => {
    context("when called by a third party", () => {
      it("should revert", async () => {
        await expect(
          donations
            .connect(thirdParty)
            .updateBeneficiary("beneficiary-id", userOne.address),
        ).to.be.revertedWithCustomError(donations, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by the owner", () => {
      let tx: ContractTransactionResponse

      context("when the recipient is non-zero address", () => {
        before(async () => {
          await createSnapshot()

          tx = await donations
            .connect(governance)
            .updateBeneficiary(beneficiaryId, recipient)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the beneficiary", async () => {
          expect(
            await donations.beneficiaryIdToRecipient(beneficiaryId),
          ).to.equal(recipient)
        })

        it("should emit BeneficiaryUpdated event", async () => {
          await expect(tx)
            .to.emit(donations, "BeneficiaryUpdated")
            .withArgs(beneficiaryId, recipient)
        })
      })

      context("when the recipient is zero address", () => {
        const newRecipient = ethers.ZeroAddress

        before(async () => {
          await createSnapshot()

          tx = await donations
            .connect(governance)
            .updateBeneficiary(beneficiaryId, newRecipient)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should update the beneficiary", async () => {
          expect(
            await donations.beneficiaryIdToRecipient(beneficiaryId),
          ).to.equal(newRecipient)
        })

        it("should emit BeneficiaryUpdated event", async () => {
          await expect(tx)
            .to.emit(donations, "BeneficiaryUpdated")
            .withArgs(beneficiaryId, newRecipient)
        })
      })
    })
  })

  describe("donate", () => {
    context("when the beneficiary is not set", () => {
      it("should revert", async () => {
        await expect(
          donations.donate(beneficiaryId, 100),
        ).to.be.revertedWithCustomError(donations, "UnsupportedBeneficiary")
      })
    })

    context("when the beneficiary is set", () => {
      const amount = 100

      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        await donations
          .connect(governance)
          .updateBeneficiary(beneficiaryId, recipient)

        await mUSD
          .connect(userOne)
          .approve(await donations.getAddress(), amount)
        tx = await donations.connect(userOne).donate(beneficiaryId, amount)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit Donated event", async () => {
        await expect(tx)
          .to.emit(donations, "Donated")
          .withArgs(userOne.address, beneficiaryId, recipient, amount)
      })

      it("should transfer the amount from the user to the recipient", async () => {
        expect(tx).to.changeTokenBalances(
          mUSD,
          [userOne.address, recipient],
          [-amount, amount],
        )
      })
    })

    context("when multiple donations are made", () => {
      const beneficiaryIdOne = "org-1"
      const beneficiaryIdTwo = "org-2"

      const recipientOne = ethers.Wallet.createRandom().address
      const recipientTwo = ethers.Wallet.createRandom().address

      const amountOne = 100
      const amountTwo = 200

      before(async () => {
        await createSnapshot()

        await donations
          .connect(governance)
          .updateBeneficiary(beneficiaryIdOne, recipientOne)
        await donations
          .connect(governance)
          .updateBeneficiary(beneficiaryIdTwo, recipientTwo)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when the donations are made to the same beneficiary", () => {
        let tx1: ContractTransactionResponse
        let tx2: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await mUSD
            .connect(userOne)
            .approve(await donations.getAddress(), amountOne)
          tx1 = await donations
            .connect(userOne)
            .donate(beneficiaryIdOne, amountOne)

          await mUSD
            .connect(userTwo)
            .approve(await donations.getAddress(), amountTwo)
          tx2 = await donations
            .connect(userTwo)
            .donate(beneficiaryIdOne, amountTwo)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Donated event", async () => {
          await expect(tx1)
            .to.emit(donations, "Donated")
            .withArgs(
              userOne.address,
              beneficiaryIdOne,
              recipientOne,
              amountOne,
            )
          await expect(tx2)
            .to.emit(donations, "Donated")
            .withArgs(
              userTwo.address,
              beneficiaryIdOne,
              recipientOne,
              amountTwo,
            )
        })

        it("should transfer the amounts from the users to the recipient", async () => {
          expect(tx1).to.changeTokenBalances(
            mUSD,
            [userOne.address, recipientOne],
            [-amountOne, amountOne],
          )
          expect(tx2).to.changeTokenBalances(
            mUSD,
            [userTwo.address, recipientOne],
            [-amountTwo, amountTwo],
          )
        })
      })

      context("when the donations are made to different beneficiaries", () => {
        let tx1: ContractTransactionResponse
        let tx2: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await mUSD
            .connect(userOne)
            .approve(await donations.getAddress(), amountOne)
          tx1 = await donations
            .connect(userOne)
            .donate(beneficiaryIdOne, amountOne)

          await mUSD
            .connect(userTwo)
            .approve(await donations.getAddress(), amountTwo)
          tx2 = await donations
            .connect(userTwo)
            .donate(beneficiaryIdTwo, amountTwo)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Donated event", async () => {
          await expect(tx1)
            .to.emit(donations, "Donated")
            .withArgs(
              userOne.address,
              beneficiaryIdOne,
              recipientOne,
              amountOne,
            )
          await expect(tx2)
            .to.emit(donations, "Donated")
            .withArgs(
              userTwo.address,
              beneficiaryIdTwo,
              recipientTwo,
              amountTwo,
            )
        })

        it("should transfer the amounts from the users to the recipient", async () => {
          expect(tx1).to.changeTokenBalances(
            mUSD,
            [userOne.address, recipientOne],
            [-amountOne, amountOne],
          )
          expect(tx2).to.changeTokenBalances(
            mUSD,
            [userTwo.address, recipientTwo],
            [-amountTwo, amountTwo],
          )
        })
      })
    })
  })

  describe("donateWithPermit", () => {
    const amount = 100n

    let deadline: bigint
    let signature: Signature

    before(async () => {
      await createSnapshot()

      deadline = BigInt((await helpers.time.lastBlockTime()) + 3600)

      signature = await signTokenPermit(
        mUSD,
        userOne,
        await donations.getAddress(),
        amount,
        deadline,
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the beneficiary is not set", () => {
      it("should revert", async () => {
        await expect(
          donations
            .connect(userOne)
            .donateWithPermit(
              beneficiaryId,
              amount,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            ),
        ).to.be.revertedWithCustomError(donations, "UnsupportedBeneficiary")
      })
    })

    context("when the beneficiary is set", () => {
      before(async () => {
        await createSnapshot()

        await donations
          .connect(governance)
          .updateBeneficiary(beneficiaryId, recipient)
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
            donations
              .connect(thirdParty)
              .donateWithPermit(
                beneficiaryId,
                amount,
                deadline,
                signature.v,
                signature.r,
                signature.s,
              ),
          ).to.be.revertedWithCustomError(mUSD, "ERC20InsufficientAllowance")
        })
      })

      context("when called by the user", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await donations
            .connect(userOne)
            .donateWithPermit(
              beneficiaryId,
              amount,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit Donated event", async () => {
          await expect(tx)
            .to.emit(donations, "Donated")
            .withArgs(userOne.address, beneficiaryId, recipient, amount)
        })

        it("should transfer the amount from the user to the recipient", async () => {
          expect(tx).to.changeTokenBalances(
            mUSD,
            [userOne.address, recipient],
            [-amount, amount],
          )
        })

        it("should fail for reused signature", async () => {
          await expect(
            donations
              .connect(userOne)
              .donateWithPermit(
                beneficiaryId,
                amount,
                deadline,
                signature.v,
                signature.r,
                signature.s,
              ),
          ).to.be.revertedWithCustomError(mUSD, "ERC20InsufficientAllowance")
        })
      })

      context("when permit is frontrun", () => {
        before(async () => {
          await createSnapshot()

          await mUSD
            .connect(thirdParty)
            .permit(
              userOne.address,
              await donations.getAddress(),
              amount,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            )
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should succeed", async () => {
          await donations
            .connect(userOne)
            .donateWithPermit(
              beneficiaryId,
              amount,
              deadline,
              signature.v,
              signature.r,
              signature.s,
            )
        })
      })
    })
  })
})
