import { ethers, helpers } from "hardhat"
import { randomBytes } from "crypto"
import {
  AbiCoder,
  ContractTransactionResponse,
  TypedDataField,
  TypedDataDomain,
  ZeroAddress,
  Signature,
} from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { expect } from "chai"
import deployPortal from "./fixtures/deployPortal"
import { MezoBridge, MockBridge, MockERC20, MockTBTCVault } from "../typechain"
import { DepositState } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Computed as in the MezoBridge contract: keccak256(abi.encode(recipient))
const encodeExtraData = (recipient: string) =>
  ethers.keccak256(AbiCoder.defaultAbiCoder().encode(["address"], [recipient]))

// Bitcoin deposit reveal data in the format accepted by tBTC bridge with the
// recipient encoded as extra data.
// Recipient is 0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3. The amount deposited
// is 20000 sat.
const getRevealData = (vault: string) => ({
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
      "c2b952f0100000000ffffffff",
    // Note that the output vector does not reflect the extraData; we use mocked
    // bridge in tests so it does not matter.
    outputVector:
      "0x02204e00000000000017a9142c1444d23936c57bdd8b3e67e5938a5440c" +
      "da455877ed73b00000000001600147ac2d9378a1c47e589dfb8095ca95ed2" +
      "140d2726",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xf9f0c90d00039524",
    walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
    refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
    refundLocktime: "0x60bcea61",
    vault,
  },
  recipient: "0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3",
  extraData: encodeExtraData("0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3"),
  // Computed by tBTC Bridge contract as
  // keccak256(abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex))
  depositKey:
    "0x6040edd35ee5e3088e0d52c2ff6308006795e6629c7de313c7889456ec8d89c7",
})

// Bitcoin deposit reveal data in the format accepted by tBTC bridge with the
// recipient encoded as extra data.
// Recipient is 0xc1D3153e41899D728b73143c4200a053C1Ca0bb5. The amount deposited
// is 10000 sat.
const getRevealDataOther = (vault: string) => ({
  fundingTx: {
    version: "0x01000000",
    inputVector:
      "0x018348cdeb551134fe1f19d378a8adec9b146671cb67b945b71bf56b20d" +
      "c2b952f0100000000ffffffff",
    // Note that the output vector does not reflect the extraData; we use mocked
    // bridge in tests so it does not matter.
    outputVector:
      "0x021027000000000000220020bfaeddba12b0de6feeb649af76376876bc1" +
      "feb6c2248fbfef9293ba3ac51bb4a10d73b00000000001600147ac2d9378a" +
      "1c47e589dfb8095ca95ed2140d2726",
    locktime: "0x00000000",
  },
  reveal: {
    fundingOutputIndex: 0,
    blindingFactor: "0xf9f0c90d00039523",
    walletPubKeyHash: "0x8db50eb52063ea9d98b3eac91489a90f738986f6",
    refundPubKeyHash: "0x28e081f285138ccbe389c1eb8985716230129f89",
    refundLocktime: "0x60bcea61",
    vault,
  },
  recipient: "0xc1D3153e41899D728b73143c4200a053C1Ca0bb5",
  extraData: encodeExtraData("0xc1D3153e41899D728b73143c4200a053C1Ca0bb5"),
  // Computed by tBTC Bridge contract as
  // keccak256(abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex))
  depositKey:
    "0xebff13c2304229ab4a97bfbfabeac82c9c0704e4aae2acf022252ac8dc1101d1",
})

describe("MezoBridge", () => {
  let TBTC: MockERC20
  let USDC: MockERC20
  let mezoBridge: MezoBridge
  let tbtcBridge: MockBridge
  let tbtcVault: MockTBTCVault
  let thirdParty: HardhatEthersSigner
  let deployer: HardhatEthersSigner
  let depositorOne: HardhatEthersSigner
  let depositorTwo: HardhatEthersSigner

  let tbtcAddress: string
  let tbtcBridgeAddress: string
  let tbtcVaultAddress: string
  let usdcAddress: string
  let mezoBridgeAddress: string

  let revealData: ReturnType<typeof getRevealData>
  let revealDataOther: ReturnType<typeof getRevealDataOther>

  const generateSignature = async (
    amount: bigint,
    spender: string,
    deadline: bigint,
    permittingHolder: HardhatEthersSigner,
  ) => {
    const chainID = (await permittingHolder.provider?.getNetwork())?.chainId

    const domain: TypedDataDomain = {
      name: await TBTC.name(),
      version: "1",
      chainId: chainID,
      verifyingContract: tbtcAddress,
    }

    const types: Record<string, TypedDataField[]> = {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    }

    const nonce = await TBTC.nonce(permittingHolder.address)

    const value = {
      owner: permittingHolder.address,
      spender,
      value: amount,
      nonce,
      deadline,
    }

    const signatureStr = await permittingHolder.signTypedData(
      domain,
      types,
      value,
    )

    return Signature.from(signatureStr)
  }

  before(async () => {
    ;({
      TBTC,
      USDC,
      tbtcAddress,
      mezoBridge,
      tbtcBridge,
      tbtcVault,
      thirdParty,
      deployer,
      depositorOne,
      depositorTwo,
    } = await loadFixture(deployPortal))

    tbtcBridgeAddress = await tbtcBridge.getAddress()
    tbtcVaultAddress = await tbtcVault.getAddress()
    usdcAddress = await USDC.getAddress()
    mezoBridgeAddress = await mezoBridge.getAddress()

    revealData = getRevealData(tbtcVaultAddress)
    revealDataOther = getRevealDataOther(tbtcVaultAddress)
  })

  describe("initialize", () => {
    context("when called directly on the implementation", () => {
      let implementation: MezoBridge

      before(async () => {
        await createSnapshot()

        const factory = await ethers.getContractFactory("MezoBridge")
        implementation = await factory.deploy()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          implementation.initialize(
            tbtcBridgeAddress,
            tbtcVaultAddress,
            tbtcAddress,
            0,
          ),
        ).to.be.revertedWithCustomError(implementation, "InvalidInitialization")
      })
    })

    context("when called on the proxy", () => {
      context("when called again", () => {
        it("should revert", async () => {
          // The initialization happened in the deployment script loaded by the
          // test fixture. Let's double check this is the case to avoid false
          // positives.
          expect(await mezoBridge.tbtcToken()).to.equal(tbtcAddress)

          await expect(
            mezoBridge.initialize(
              tbtcBridgeAddress,
              tbtcVaultAddress,
              tbtcAddress,
              0,
            ),
          ).to.be.revertedWithCustomError(mezoBridge, "InvalidInitialization")
        })
      })

      const deployProxy = async (initializerArgs: unknown[]) => {
        await helpers.upgrades.deployProxy(
          // Hacky workaround allowing to deploy proxy contract any number of times
          // without clearing `deployments/hardhat` directory.
          // See: https://github.com/keep-network/hardhat-helpers/issues/38
          `MezoBridge${randomBytes(8).toString("hex")}`,
          {
            contractName: "MezoBridge",
            initializerArgs,
            factoryOpts: { signer: deployer },
            proxyOpts: {
              kind: "transparent",
            },
          },
        )
      }

      context("when called with zero-address bridge", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([ZeroAddress, tbtcVaultAddress, tbtcAddress, 0]),
          ).to.be.revertedWith("Bridge address cannot be zero")
        })
      })

      context("when called with zero-address tBTC vault", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([tbtcBridgeAddress, ZeroAddress, tbtcAddress, 0]),
          ).to.be.revertedWith("TBTCVault address cannot be zero")
        })
      })

      context("when called with zero-address tBTC token", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([tbtcBridgeAddress, tbtcVaultAddress, ZeroAddress, 0]),
          ).to.be.revertedWithCustomError(mezoBridge, "TBTCTokenIsZeroAddress")
        })
      })
    })
  })

  describe("updateMinTBTCAmount", () => {
    context("when caller is not owner", () => {
      it("should revert", async () => {
        await expect(mezoBridge.connect(thirdParty).updateMinTBTCAmount(123456))
          .to.be.revertedWithCustomError(
            mezoBridge,
            "OwnableUnauthorizedAccount",
          )
          .withArgs(thirdParty.address)
      })
    })

    context("when caller is owner", () => {
      context("when called with zero", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge.connect(deployer).updateMinTBTCAmount(0),
          ).to.be.revertedWithCustomError(mezoBridge, "MinTBTCAmountIsZero")
        })
      })

      context("when called with a positive number", () => {
        const newMinTBTCAmount = 987654321
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          tx = await mezoBridge
            .connect(deployer)
            .updateMinTBTCAmount(newMinTBTCAmount)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit MinTBTCAmountUpdated event", async () => {
          await expect(tx)
            .to.emit(mezoBridge, "MinTBTCAmountUpdated")
            .withArgs(newMinTBTCAmount)
        })

        it("should update value correctly", async () => {
          expect(await mezoBridge.minTBTCAmount()).to.be.eq(newMinTBTCAmount)
        })
      })
    })
  })

  describe("initializeBTCBridging", () => {
    context("when the recipient is zero address", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.initializeBTCBridging(
            revealData.fundingTx,
            revealData.reveal,
            ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(mezoBridge, "BTCRecipientIsZeroAddress")
      })
    })

    context("when the deposit was already initialized", () => {
      before(async () => {
        await createSnapshot()

        await mezoBridge.initializeBTCBridging(
          revealData.fundingTx,
          revealData.reveal,
          revealData.recipient,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          mezoBridge.initializeBTCBridging(
            revealData.fundingTx,
            revealData.reveal,
            revealData.recipient,
          ),
        ).to.be.revertedWith("Deposit already revealed")
      })
    })

    context("when initializing for the first time", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await mezoBridge.initializeBTCBridging(
          revealData.fundingTx,
          revealData.reveal,
          revealData.recipient,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the deposit state to Initialized", async () => {
        expect(await mezoBridge.btcDeposits(revealData.depositKey)).to.equal(
          DepositState.Initialized,
        )
        expect(
          await mezoBridge.btcDeposits(revealDataOther.depositKey),
        ).to.equal(DepositState.Unknown)
      })

      it("should emit BTCDepositInitialized event", async () => {
        await expect(tx)
          .to.emit(mezoBridge, "BTCDepositInitialized")
          .withArgs(revealData.depositKey, revealData.recipient)
      })
    })
  })

  describe("finalizeBTCBridging", () => {
    context("when the deposit was not initialized before", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.finalizeBTCBridging(
            revealData.depositKey,
            revealData.recipient,
          ),
        )
          .to.be.revertedWithCustomError(
            mezoBridge,
            "UnexpectedBTCDepositState",
          )
          .withArgs(DepositState.Unknown, DepositState.Initialized)
      })
    })

    context("when the deposit was not finalized by the bridge", () => {
      before(async () => {
        await createSnapshot()

        await mezoBridge.initializeBTCBridging(
          revealData.fundingTx,
          revealData.reveal,
          revealData.recipient,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          mezoBridge.finalizeBTCBridging(
            revealData.depositKey,
            revealData.recipient,
          ),
        ).to.be.revertedWith("Deposit not finalized by the bridge")
      })
    })

    context("when deposit was finalized by the bridge", () => {
      before(async () => {
        await createSnapshot()

        await mezoBridge.initializeBTCBridging(
          revealData.fundingTx,
          revealData.reveal,
          revealData.recipient,
        )

        await mezoBridge.initializeBTCBridging(
          revealDataOther.fundingTx,
          revealDataOther.reveal,
          revealDataOther.recipient,
        )

        await tbtcVault.createOptimisticMintingRequest(revealData.depositKey)
        await tbtcVault.createOptimisticMintingRequest(
          revealDataOther.depositKey,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when a single deposit was finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealData.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealData.depositKey)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when recipient param is different than during the initialization",
          () => {
            it("should revert", async () => {
              await expect(
                mezoBridge.finalizeBTCBridging(
                  revealData.depositKey,
                  thirdParty.address,
                ),
              )
                .to.be.revertedWithCustomError(
                  mezoBridge,
                  "UnexpectedExtraData",
                )
                .withArgs(
                  encodeExtraData(thirdParty.address),
                  revealData.extraData,
                )
            })
          },
        )

        context(
          "when called with the same params as during the initialization",
          () => {
            let tx: ContractTransactionResponse

            // The expected tbtcAmount is calculated as follows:
            //
            // - Deposit amount = 20000 satoshi (hardcoded in funding transaction fixture)
            // - Treasury fee = 2% (default value used in MockBridge)
            // - Optimistic minting fee = 1% (default value used in MockTBTCVault)
            // - Transaction max fee = 1000 satoshi (default value used in MockBridge)
            //
            // ((20000 sat * 0.98) * 0.99) - 1000 sat = 18404 sat = 18404 * 1e10 TBTC
            // See AbstractTBTCDepositor._calculateTbtcAmount docs for explanation.
            // The expected surplus (no transaction fee) is 1000 * 1e10 TBTC
            // The expected locked tBTC amount is equal to the sum of expected
            // tBTC amount and surplus.
            const expectedInitialDepositAmount = 200000000000000
            const expectedTbtcAmount = 184040000000000

            const expectedSurplus = 10000000000000
            const expectedLockedAmount = expectedTbtcAmount + expectedSurplus

            const expectedAssetsSequence = 1 // It is the first asset locked

            before(async () => {
              await createSnapshot()

              tx = await mezoBridge.finalizeBTCBridging(
                revealData.depositKey,
                revealData.recipient,
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit BTCDepositFinalized event", async () => {
              await expect(tx)
                .to.emit(mezoBridge, "BTCDepositFinalized")
                .withArgs(
                  revealData.depositKey,
                  expectedInitialDepositAmount,
                  expectedTbtcAmount,
                )
            })

            it("should emit AssetsLocked event", async () => {
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(
                  expectedAssetsSequence,
                  revealData.recipient,
                  tbtcAddress,
                  expectedTbtcAmount,
                )
            })

            it("should set the deposit state to Finalized", async () => {
              expect(
                await mezoBridge.btcDeposits(revealData.depositKey),
              ).to.equal(DepositState.Finalized)
            })

            it("should lock tBTC in the MezoBridge contract", async () => {
              expect(await TBTC.balanceOf(mezoBridgeAddress)).to.equal(
                expectedLockedAmount,
              )
            })
          },
        )
      })

      context("when multiple deposits were finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealData.depositKey,
          )
          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataOther.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealData.depositKey)
          await tbtcBridge.sweepDeposit(revealDataOther.depositKey)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when called with the same params as during the initialization",
          () => {
            let tx1: ContractTransactionResponse
            let tx2: ContractTransactionResponse

            // The value hardcoded in the Bitcoin transaction
            const expectedFirstDepositInitialAmount = 100000000000000
            // The value hardcoded in the Bitcoin transaction
            const expectedSecondDepositInitialAmount = 200000000000000
            // ((10000 sat - 200 sat) * 0.99) - 1000 sat = 8702 sat = 8702 * 1e10 TBTC
            const expectedFirstDepositTbtcAmount = 87020000000000
            // ((20000 sat * 0.98) * 0.99) - 1000 sat = 18404 sat = 18404 * 1e10 TBTC
            const expectedSecondDepositTbtcAmount = 184040000000000
            // Twice the transaction max fee = 1000 satoshi (default value used in MockBridge)
            const surplus = 20000000000000

            // Locked tBTC amount is equal to the sum of both deposits and
            // the surplus. See AbstractTBTCDepositor._calculateTbtcAmount docs.
            const expectedLockedTbtcAmount =
              expectedFirstDepositTbtcAmount +
              expectedSecondDepositTbtcAmount +
              surplus

            before(async () => {
              await createSnapshot()

              tx1 = await mezoBridge.finalizeBTCBridging(
                revealDataOther.depositKey,
                revealDataOther.recipient,
              )

              tx2 = await mezoBridge.finalizeBTCBridging(
                revealData.depositKey,
                revealData.recipient,
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit BTCDepositFinalized events", async () => {
              await expect(tx1)
                .to.emit(mezoBridge, "BTCDepositFinalized")
                .withArgs(
                  revealDataOther.depositKey,
                  expectedFirstDepositInitialAmount,
                  expectedFirstDepositTbtcAmount,
                )

              await expect(tx2)
                .to.emit(mezoBridge, "BTCDepositFinalized")
                .withArgs(
                  revealData.depositKey,
                  expectedSecondDepositInitialAmount,
                  expectedSecondDepositTbtcAmount,
                )
            })

            it("should emit AssetsLocked events", async () => {
              await expect(tx1)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(
                  1,
                  revealDataOther.recipient,
                  tbtcAddress,
                  expectedFirstDepositTbtcAmount,
                )

              await expect(tx2)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(
                  2,
                  revealData.recipient,
                  tbtcAddress,
                  expectedSecondDepositTbtcAmount,
                )
            })

            it("should lock tBTC in the MezoBridge contract", async () => {
              expect(await TBTC.balanceOf(mezoBridgeAddress)).to.equal(
                expectedLockedTbtcAmount,
              )
            })
          },
        )
      })

      context("when called for the same deposit second time", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealData.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealData.depositKey)

          await mezoBridge.finalizeBTCBridging(
            revealData.depositKey,
            revealData.recipient,
          )

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataOther.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataOther.depositKey)

          await mezoBridge.finalizeBTCBridging(
            revealDataOther.depositKey,
            revealDataOther.recipient,
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when called with the same params", () => {
          it("should revert", async () => {
            await expect(
              mezoBridge.finalizeBTCBridging(
                revealData.depositKey,
                revealData.recipient,
              ),
            )
              .to.be.revertedWithCustomError(
                mezoBridge,
                "UnexpectedBTCDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)

            await expect(
              mezoBridge.finalizeBTCBridging(
                revealDataOther.depositKey,
                revealDataOther.recipient,
              ),
            )
              .to.be.revertedWithCustomError(
                mezoBridge,
                "UnexpectedBTCDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)
          })
        })

        context("when called with different params", () => {
          it("should revert", async () => {
            await expect(
              mezoBridge.finalizeBTCBridging(
                revealData.depositKey,
                thirdParty.address,
              ),
            )
              .to.be.revertedWithCustomError(
                mezoBridge,
                "UnexpectedBTCDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)
          })
        })
      })
    })
  })

  describe("bridgeTBTC", () => {
    context("when called with zero recipient address", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.connect(depositorOne).bridgeTBTC(1000, ZeroAddress),
        ).to.be.revertedWithCustomError(mezoBridge, "BTCRecipientIsZeroAddress")
      })
    })

    context("when called with non-zero recipient address", () => {
      context("when called with amount below minimum tBTC amount", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge.connect(depositorOne).bridgeTBTC(0, thirdParty),
          ).to.be.revertedWithCustomError(
            mezoBridge,
            "AmountBelowMinTBTCAmount",
          )
        })
      })

      context("when called with correct amount", () => {
        context(
          "when not enough tBTC has been approved for Bitcoin bridge",
          () => {
            const amountToBridge = 12000000000000000n

            // Approve slightly less than the bridged amount.
            const allowance = amountToBridge - 1n

            before(async () => {
              await createSnapshot()

              await TBTC.connect(depositorOne).approve(mezoBridge, allowance)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                mezoBridge
                  .connect(depositorOne)
                  .bridgeTBTC(amountToBridge, thirdParty),
              )
                .to.be.revertedWithCustomError(
                  TBTC,
                  "ERC20InsufficientAllowance",
                )
                .withArgs(mezoBridge, allowance, amountToBridge)
            })
          },
        )

        context(
          "when enough tBTC hash been approved for Bitcoin bridge",
          () => {
            context("when called by a single depositor", () => {
              const amountToBridge = 12000000000000000n

              let balanceBefore: bigint
              let tx: ContractTransactionResponse

              before(async () => {
                await createSnapshot()

                balanceBefore = await TBTC.balanceOf(depositorOne)

                await TBTC.connect(depositorOne).approve(
                  mezoBridge,
                  amountToBridge,
                )

                tx = await mezoBridge
                  .connect(depositorOne)
                  .bridgeTBTC(amountToBridge, thirdParty)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should emit AssetsLocked event", async () => {
                await expect(tx)
                  .to.emit(mezoBridge, "AssetsLocked")
                  .withArgs(1, thirdParty, tbtcAddress, amountToBridge)
              })

              it("should transfer the token to the contract", async () => {
                expect(await TBTC.balanceOf(mezoBridge)).to.equal(
                  amountToBridge,
                )
                expect(await TBTC.balanceOf(depositorOne)).to.equal(
                  balanceBefore - amountToBridge,
                )
              })
            })

            context("when called by multiple depositors", () => {
              const amountDepositorOne = 12000000000000000n
              const amountDepositorTwo = 15000000000000000n

              let balanceBeforeDepositorOne: bigint
              let balanceBeforeDepositorTwo: bigint

              let tx1: ContractTransactionResponse
              let tx2: ContractTransactionResponse

              before(async () => {
                await createSnapshot()

                balanceBeforeDepositorOne = await TBTC.balanceOf(depositorOne)
                balanceBeforeDepositorTwo = await TBTC.balanceOf(depositorTwo)

                await TBTC.connect(depositorOne).approve(
                  mezoBridge,
                  amountDepositorOne,
                )
                await TBTC.connect(depositorTwo).approve(
                  mezoBridge,
                  amountDepositorTwo,
                )

                tx1 = await mezoBridge
                  .connect(depositorOne)
                  .bridgeTBTC(amountDepositorOne, thirdParty)
                tx2 = await mezoBridge.connect(depositorTwo).bridgeTBTC(
                  amountDepositorTwo,
                  depositorTwo, // Bridge to own address
                )
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should emit AssetsLocked event", async () => {
                await expect(tx1)
                  .to.emit(mezoBridge, "AssetsLocked")
                  .withArgs(1, thirdParty, tbtcAddress, amountDepositorOne)
                await expect(tx2)
                  .to.emit(mezoBridge, "AssetsLocked")
                  .withArgs(2, depositorTwo, tbtcAddress, amountDepositorTwo)
              })

              it("should transfer the token to the contract", async () => {
                expect(await TBTC.balanceOf(mezoBridge)).to.equal(
                  amountDepositorOne + amountDepositorTwo,
                )
                expect(await TBTC.balanceOf(depositorOne)).to.equal(
                  balanceBeforeDepositorOne - amountDepositorOne,
                )
                expect(await TBTC.balanceOf(depositorTwo)).to.equal(
                  balanceBeforeDepositorTwo - amountDepositorTwo,
                )
              })
            })
          },
        )
      })
    })
  })

  describe("bridgeTBTCWithPermit", () => {
    context("when allowance is sufficient", () => {
      // When the tBTC allowance is sufficient, the call to the `permit`
      // function is skipped and the execution is the same as for `bridgeTBTC`.
      // As `bridgeTBTC` is covered by tests in its dedicated section, we only
      // test a simple success scenario here.
      const amountToBridge = 12000000000000000n

      let balanceBefore: bigint
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        balanceBefore = await TBTC.balanceOf(depositorOne)

        await TBTC.connect(depositorOne).approve(mezoBridge, amountToBridge)

        // Use any values for `deadline`, `v`, `r` and `s` parameters as they
        // are not validated when the `permit` function is skipped.
        tx = await mezoBridge
          .connect(depositorOne)
          .bridgeTBTCWithPermit(
            amountToBridge,
            thirdParty,
            111n,
            27,
            `0x${"11".repeat(32)}`,
            `0x${"22".repeat(32)}`,
          )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit AssetsLocked event", async () => {
        await expect(tx)
          .to.emit(mezoBridge, "AssetsLocked")
          .withArgs(1, thirdParty, tbtcAddress, amountToBridge)
      })

      it("should transfer the token to the contract", async () => {
        expect(await TBTC.balanceOf(mezoBridge)).to.equal(amountToBridge)
        expect(await TBTC.balanceOf(depositorOne)).to.equal(
          balanceBefore - amountToBridge,
        )
      })
    })

    context("when allowance is not sufficient", () => {
      const amountToBridge = 12000000000000000n

      let deadline: bigint
      let signature: Signature

      before(async () => {
        await createSnapshot()

        // Set deadline to tomorrow.
        deadline = BigInt((await helpers.time.lastBlockTime()) + 86400)

        // The signature is generated by `depositorOne`.
        signature = await generateSignature(
          amountToBridge,
          mezoBridgeAddress,
          deadline,
          depositorOne,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when parameters are incorrect", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge.connect(depositorOne).bridgeTBTCWithPermit(
              amountToBridge,
              thirdParty,
              deadline,
              signature.v,
              signature.s, // Use `s` instead of `r`.
              signature.s,
            ),
          ).to.be.revertedWith("Invalid signature")
        })
      })

      context("when parameters are correct", () => {
        context("when called by another account", () => {
          it("should revert", async () => {
            await expect(
              // Connect using a different account. Even though all the passed
              // parameters are correct, the function should revert.
              // The function only works when called by the account that
              // generated the signature.
              mezoBridge
                .connect(depositorTwo)
                .bridgeTBTCWithPermit(
                  amountToBridge,
                  thirdParty,
                  deadline,
                  signature.v,
                  signature.r,
                  signature.s,
                ),
            ).to.be.revertedWith("Invalid signature")
          })
        })

        context("when called by the signer", () => {
          let balanceBefore: bigint
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            balanceBefore = await TBTC.balanceOf(depositorOne)

            tx = await mezoBridge
              .connect(depositorOne)
              .bridgeTBTCWithPermit(
                amountToBridge,
                thirdParty,
                deadline,
                signature.v,
                signature.r,
                signature.s,
              )
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit AssetsLocked event", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "AssetsLocked")
              .withArgs(1, thirdParty, tbtcAddress, amountToBridge)
          })

          it("should transfer the token to the contract", async () => {
            expect(await TBTC.balanceOf(mezoBridge)).to.equal(amountToBridge)
            expect(await TBTC.balanceOf(depositorOne)).to.equal(
              balanceBefore - amountToBridge,
            )
          })
        })
      })
    })
  })

  describe("enableERC20Token", () => {
    context("when caller is not owner", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.connect(thirdParty).enableERC20Token(usdcAddress, 1),
        )
          .to.be.revertedWithCustomError(
            mezoBridge,
            "OwnableUnauthorizedAccount",
          )
          .withArgs(thirdParty.address)
      })
    })

    context("when caller is owner", () => {
      context("when token address is zero", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge
              .connect(deployer)
              .enableERC20Token(ethers.ZeroAddress, 1),
          ).to.be.revertedWithCustomError(mezoBridge, "ERC20TokenIsZeroAddress")
        })
      })

      context("when token address is non-zero", () => {
        context("when min amount is zero", () => {
          it("should revert", async () => {
            await expect(
              mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 0),
            ).to.be.revertedWithCustomError(mezoBridge, "MinERC20AmountIsZero")
          })
        })

        context("when min amount is positive", () => {
          context("when token already enabled", () => {
            before(async () => {
              await createSnapshot()

              await mezoBridge
                .connect(deployer)
                .enableERC20Token(usdcAddress, 1)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 1),
              ).to.be.revertedWithCustomError(
                mezoBridge,
                "ERC20TokenAlreadyEnabled",
              )
            })
          })

          context("when token not already enabled", () => {
            context("when max tokens reached", () => {
              before(async () => {
                await createSnapshot()

                const max = await mezoBridge.MAX_ERC20_TOKENS()

                // eslint-disable-next-line no-plusplus
                for (let i = 0; i < max; i++) {
                  const address =
                    // eslint-disable-next-line no-await-in-loop
                    await ethers.Wallet.createRandom().getAddress()

                  // eslint-disable-next-line no-await-in-loop
                  await mezoBridge
                    .connect(deployer)
                    .enableERC20Token(address, 1)
                }
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should revert", async () => {
                await expect(
                  mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 1),
                ).to.be.revertedWithCustomError(
                  mezoBridge,
                  "MaxERC20TokensReached",
                )
              })
            })

            context("when max tokens not reached", () => {
              let tx: ContractTransactionResponse

              before(async () => {
                await createSnapshot()

                tx = await mezoBridge
                  .connect(deployer)
                  .enableERC20Token(usdcAddress, 10)
              })

              after(async () => {
                await restoreSnapshot()
              })

              it("should set the token as enabled", async () => {
                expect(await mezoBridge.ERC20Tokens(usdcAddress)).to.equal(10)
              })

              it("should increment the number of enabled tokens", async () => {
                expect(await mezoBridge.ERC20TokensCount()).to.equal(1)
              })

              it("should emit ERC20TokenEnabled event", async () => {
                await expect(tx)
                  .to.emit(mezoBridge, "ERC20TokenEnabled")
                  .withArgs(usdcAddress, 10)
              })
            })
          })
        })
      })
    })
  })

  describe("disableERC20Token", () => {
    context("when caller is not owner", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.connect(thirdParty).disableERC20Token(usdcAddress),
        )
          .to.be.revertedWithCustomError(
            mezoBridge,
            "OwnableUnauthorizedAccount",
          )
          .withArgs(thirdParty.address)
      })
    })

    context("when caller is owner", () => {
      context("when token is not enabled", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge.connect(deployer).disableERC20Token(usdcAddress),
          ).to.be.revertedWithCustomError(mezoBridge, "ERC20TokenNotEnabled")
        })
      })

      context("when token is enabled", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 10)

          tx = await mezoBridge.connect(deployer).disableERC20Token(usdcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should set the token as disabled", async () => {
          expect(await mezoBridge.ERC20Tokens(usdcAddress)).to.equal(0)
        })

        it("should decrement the number of enabled tokens", async () => {
          expect(await mezoBridge.ERC20TokensCount()).to.equal(0)
        })

        it("should emit ERC20TokenDisabled event", async () => {
          await expect(tx)
            .to.emit(mezoBridge, "ERC20TokenDisabled")
            .withArgs(usdcAddress)
        })
      })
    })
  })

  describe("updateMinERC20Amount", () => {
    context("when caller is not owner", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge.connect(thirdParty).updateMinERC20Amount(usdcAddress, 1),
        )
          .to.be.revertedWithCustomError(
            mezoBridge,
            "OwnableUnauthorizedAccount",
          )
          .withArgs(thirdParty.address)
      })
    })

    context("when caller is owner", () => {
      context("when token is not enabled", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge.connect(deployer).updateMinERC20Amount(usdcAddress, 1),
          ).to.be.revertedWithCustomError(mezoBridge, "ERC20TokenNotEnabled")
        })
      })

      context("when token is enabled", () => {
        before(async () => {
          await createSnapshot()

          await mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 10)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when new min amount is zero", () => {
          it("should revert", async () => {
            await expect(
              mezoBridge.connect(deployer).updateMinERC20Amount(usdcAddress, 0),
            ).to.be.revertedWithCustomError(mezoBridge, "MinERC20AmountIsZero")
          })
        })

        context("when new min amount is positive", () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            tx = await mezoBridge
              .connect(deployer)
              .updateMinERC20Amount(usdcAddress, 50)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should update the min amount correctly", async () => {
            expect(await mezoBridge.ERC20Tokens(usdcAddress)).to.equal(50)
          })

          it("should emit MinERC20AmountUpdated event", async () => {
            await expect(tx)
              .to.emit(mezoBridge, "MinERC20AmountUpdated")
              .withArgs(usdcAddress, 50)
          })
        })
      })
    })
  })

  describe("bridgeERC20", () => {
    context("when token is not enabled", () => {
      it("should revert", async () => {
        await expect(
          mezoBridge
            .connect(depositorOne)
            .bridgeERC20(usdcAddress, 1000, thirdParty),
        ).to.be.revertedWithCustomError(mezoBridge, "ERC20TokenNotEnabled")
      })
    })

    context("when token is enabled", () => {
      before(async () => {
        await createSnapshot()

        await mezoBridge.connect(deployer).enableERC20Token(usdcAddress, 10)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when recipient is zero address", () => {
        it("should revert", async () => {
          await expect(
            mezoBridge
              .connect(depositorOne)
              .bridgeERC20(usdcAddress, 1000, ZeroAddress),
          ).to.be.revertedWithCustomError(
            mezoBridge,
            "ERC20RecipientIsZeroAddress",
          )
        })
      })

      context("when recipient is non-zero address", () => {
        context("when amount is below minimum", () => {
          it("should revert", async () => {
            await expect(
              // The minimum amount is set to 10.
              mezoBridge
                .connect(depositorOne)
                .bridgeERC20(usdcAddress, 9, thirdParty),
            ).to.be.revertedWithCustomError(
              mezoBridge,
              "AmountBelowMinERC20Amount",
            )
          })
        })

        context("when amount is above minimum", () => {
          context("when allowance is not sufficient", () => {
            it("should revert", async () => {
              await expect(
                mezoBridge
                  .connect(depositorOne)
                  .bridgeERC20(usdcAddress, 10, thirdParty),
              )
                .to.be.revertedWithCustomError(
                  USDC,
                  "ERC20InsufficientAllowance",
                )
                .withArgs(mezoBridge, 0, 10)
            })
          })

          context("when allowance is sufficient", () => {
            let tx: ContractTransactionResponse

            before(async () => {
              await createSnapshot()

              // depositorOne has some USDC minted during the fixture setup.
              await USDC.connect(depositorOne).approve(mezoBridge, 10)

              tx = await mezoBridge
                .connect(depositorOne)
                .bridgeERC20(usdcAddress, 10, thirdParty)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit AssetsLocked event", async () => {
              await expect(tx)
                .to.emit(mezoBridge, "AssetsLocked")
                .withArgs(1, thirdParty, usdcAddress, 10)
            })

            it("should transfer the token to the MezoBridge contract", async () => {
              await expect(tx).to.changeTokenBalance(USDC, mezoBridge, 10)
              await expect(tx).to.changeTokenBalance(USDC, depositorOne, -10)
            })
          })
        })
      })
    })
  })
})
