import { ethers, helpers } from "hardhat"
import { randomBytes } from "crypto"
import { AbiCoder, ContractTransactionResponse, ZeroAddress } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import deployPortal from "./fixtures/deployPortal"
import {
  BitcoinDepositor,
  MockBridge,
  MockERC20,
  MockTBTCVault,
  Portal,
} from "../typechain"
import { DepositState } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

// Computed as in the BitcoinDepositor contract:
// keccak256(abi.encode(depositOwner, depositLockPeriod))
const encodeExtraData = (depositOwner: string, depositLockPeriod: number) =>
  ethers.keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ["address", "uint32"],
      [depositOwner, depositLockPeriod],
    ),
  )

// Bitcoin deposit reveal data in the format accepted by tBTC bridge
// with the deposit owner and lock period encoded as extra data.
// Deposit owner is 0xc1D3153e41899D728b73143c4200a053C1Ca0bb5 and there is
// 12 weeks lock period. The amount deposited is 10000 sat.
const getRevealDataWithLock = (vault: string) => ({
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
  depositOwner: "0xc1D3153e41899D728b73143c4200a053C1Ca0bb5",
  depositLockPeriod: 7257600,
  extraData: encodeExtraData(
    "0xc1D3153e41899D728b73143c4200a053C1Ca0bb5",
    7257600,
  ),
  // Computed by tBTC Bridge contract as
  // keccak256(abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex))
  depositKey:
    "0xebff13c2304229ab4a97bfbfabeac82c9c0704e4aae2acf022252ac8dc1101d1",
})

// Bitcoin deposit reveal data in the format accepted by tBTC bridge
// with the deposit owner and lock period encoded as extra data.
// Deposit owner is 0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3 and there is no
// lock. The amount deposited is 20000 sat.
const getRevealDataWithNoLock = (vault: string) => ({
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
  depositOwner: "0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3",
  depositLockPeriod: 0,
  extraData: encodeExtraData("0x4ae3441CFcD6F6E11D11539cc5FcC665b4A357c3", 0),
  // Computed by tBTC Bridge contract as
  // keccak256(abi.encodePacked(fundingTxHash, reveal.fundingOutputIndex))
  depositKey:
    "0x6040edd35ee5e3088e0d52c2ff6308006795e6629c7de313c7889456ec8d89c7",
})

describe("BitcoinDepositor", () => {
  let TBTC: MockERC20
  let portal: Portal
  let bitcoinDepositor: BitcoinDepositor
  let tbtcBridge: MockBridge
  let tbtcVault: MockTBTCVault
  let thirdParty: HardhatEthersSigner
  let deployer: HardhatEthersSigner

  let tbtcBridgeAddress: string
  let tbtcAddress: string
  let tbtcVaultAddress: string
  let portalAddress: string
  let bitcoinDepositorAddress: string

  let revealDataWithLock: ReturnType<typeof getRevealDataWithLock>
  let revealDataWithNoLock: ReturnType<typeof getRevealDataWithNoLock>

  before(async () => {
    ;({
      TBTC,
      tbtcAddress,
      portal,
      bitcoinDepositor,
      tbtcBridge,
      tbtcVault,
      thirdParty,
      deployer,
    } = await loadFixture(deployPortal))

    tbtcBridgeAddress = await tbtcBridge.getAddress()
    tbtcVaultAddress = await tbtcVault.getAddress()
    portalAddress = await portal.getAddress()
    bitcoinDepositorAddress = await bitcoinDepositor.getAddress()

    revealDataWithLock = getRevealDataWithLock(tbtcVaultAddress)
    revealDataWithNoLock = getRevealDataWithNoLock(tbtcVaultAddress)
  })

  describe("initialize", () => {
    context("when called directly on the implementation", () => {
      let implementation: BitcoinDepositor

      before(async () => {
        await createSnapshot()

        const factory = await ethers.getContractFactory("BitcoinDepositor")
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
            portalAddress,
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
          expect(await bitcoinDepositor.tbtcToken()).to.equal(tbtcAddress)

          await expect(
            bitcoinDepositor.initialize(
              tbtcBridgeAddress,
              tbtcVaultAddress,
              tbtcAddress,
              portalAddress,
            ),
          ).to.be.revertedWithCustomError(
            bitcoinDepositor,
            "InvalidInitialization",
          )
        })
      })

      const deployProxy = async (initializerArgs: unknown[]) => {
        await helpers.upgrades.deployProxy(
          // Hacky workaround allowing to deploy proxy contract any number of times
          // without clearing `deployments/hardhat` directory.
          // See: https://github.com/keep-network/hardhat-helpers/issues/38
          `BitcoinDepositor${randomBytes(8).toString("hex")}`,
          {
            contractName: "BitcoinDepositor",
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
            deployProxy([
              ZeroAddress,
              tbtcVaultAddress,
              tbtcAddress,
              portalAddress,
            ]),
          ).to.be.revertedWith("Bridge address cannot be zero")
        })
      })

      context("when called with zero-address tBTC vault", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([
              tbtcBridgeAddress,
              ZeroAddress,
              tbtcAddress,
              portalAddress,
            ]),
          ).to.be.revertedWith("TBTCVault address cannot be zero")
        })
      })

      context("when called with zero-address tBTC token", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([
              tbtcBridgeAddress,
              tbtcVaultAddress,
              ZeroAddress,
              portalAddress,
            ]),
          ).to.be.revertedWith("tBTC token address cannot be zero")
        })
      })

      context("when called with zero-address portal", () => {
        it("should revert", async () => {
          await expect(
            deployProxy([
              tbtcBridgeAddress,
              tbtcVaultAddress,
              tbtcAddress,
              ZeroAddress,
            ]),
          ).to.be.revertedWith("Portal contract address cannot be zero")
        })
      })
    })
  })

  describe("initializeDeposit", () => {
    context("when the deposit owner is zero address", () => {
      it("should revert", async () => {
        await expect(
          bitcoinDepositor.initializeDeposit(
            revealDataWithLock.fundingTx,
            revealDataWithLock.reveal,
            ZeroAddress,
            revealDataWithLock.depositLockPeriod,
          ),
        ).to.be.revertedWith("Deposit owner must not be 0x0")
      })
    })

    context("when the deposit was already initialized", () => {
      before(async () => {
        await createSnapshot()

        await bitcoinDepositor.initializeDeposit(
          revealDataWithLock.fundingTx,
          revealDataWithLock.reveal,
          revealDataWithLock.depositOwner,
          revealDataWithLock.depositLockPeriod,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bitcoinDepositor.initializeDeposit(
            revealDataWithLock.fundingTx,
            revealDataWithLock.reveal,
            revealDataWithLock.depositOwner,
            revealDataWithLock.depositLockPeriod,
          ),
        ).to.be.revertedWith("Deposit already revealed")
      })
    })

    context("when initializing for the first time", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await bitcoinDepositor.initializeDeposit(
          revealDataWithLock.fundingTx,
          revealDataWithLock.reveal,
          revealDataWithLock.depositOwner,
          revealDataWithLock.depositLockPeriod,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should set the deposit state to Initialized", async () => {
        expect(
          await bitcoinDepositor.deposits(revealDataWithLock.depositKey),
        ).to.equal(DepositState.Initialized)
        expect(
          await bitcoinDepositor.deposits(revealDataWithNoLock.depositKey),
        ).to.equal(DepositState.Unknown)
      })

      it("should emit DepositInitialized event", async () => {
        await expect(tx)
          .to.emit(bitcoinDepositor, "DepositInitialized")
          .withArgs(
            revealDataWithLock.depositKey,
            revealDataWithLock.depositOwner,
            revealDataWithLock.depositLockPeriod,
          )
      })
    })
  })

  describe("finalizeDeposit", () => {
    context("when the deposit was not initialized before", () => {
      it("should revert", async () => {
        await expect(
          bitcoinDepositor.finalizeDeposit(
            revealDataWithLock.depositKey,
            revealDataWithLock.depositOwner,
            revealDataWithLock.depositLockPeriod,
          ),
        )
          .to.be.revertedWithCustomError(
            bitcoinDepositor,
            "UnexpectedDepositState",
          )
          .withArgs(DepositState.Unknown, DepositState.Initialized)
      })
    })

    context("when the deposit was not finalized by the bridge", () => {
      before(async () => {
        await createSnapshot()

        await bitcoinDepositor.initializeDeposit(
          revealDataWithLock.fundingTx,
          revealDataWithLock.reveal,
          revealDataWithLock.depositOwner,
          revealDataWithLock.depositLockPeriod,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          bitcoinDepositor.finalizeDeposit(
            revealDataWithLock.depositKey,
            revealDataWithLock.depositOwner,
            revealDataWithLock.depositLockPeriod,
          ),
        ).to.be.revertedWith("Deposit not finalized by the bridge")
      })
    })

    context("when deposit was finalized by the bridge", () => {
      before(async () => {
        await createSnapshot()

        await bitcoinDepositor.initializeDeposit(
          revealDataWithLock.fundingTx,
          revealDataWithLock.reveal,
          revealDataWithLock.depositOwner,
          revealDataWithLock.depositLockPeriod,
        )

        await bitcoinDepositor.initializeDeposit(
          revealDataWithNoLock.fundingTx,
          revealDataWithNoLock.reveal,
          revealDataWithNoLock.depositOwner,
          revealDataWithNoLock.depositLockPeriod,
        )

        await tbtcVault.createOptimisticMintingRequest(
          revealDataWithLock.depositKey,
        )
        await tbtcVault.createOptimisticMintingRequest(
          revealDataWithNoLock.depositKey,
        )
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when a single, non-lockable deposit was finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithNoLock.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataWithNoLock.depositKey)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when deposit owner param is different than during the initialization",
          () => {
            it("should revert", async () => {
              await expect(
                bitcoinDepositor.finalizeDeposit(
                  revealDataWithNoLock.depositKey,
                  thirdParty.address,
                  revealDataWithNoLock.depositLockPeriod,
                ),
              )
                .to.be.revertedWithCustomError(
                  bitcoinDepositor,
                  "UnexpectedExtraData",
                )
                .withArgs(
                  encodeExtraData(
                    thirdParty.address,
                    revealDataWithNoLock.depositLockPeriod,
                  ),
                  revealDataWithNoLock.extraData,
                )
            })
          },
        )

        context(
          "when deposit lock period param is different than during the initialization",
          () => {
            it("should revert", async () => {
              await expect(
                bitcoinDepositor.finalizeDeposit(
                  revealDataWithNoLock.depositKey,
                  revealDataWithNoLock.depositOwner,
                  1,
                ),
              )
                .to.be.revertedWithCustomError(
                  bitcoinDepositor,
                  "UnexpectedExtraData",
                )
                .withArgs(
                  encodeExtraData(revealDataWithNoLock.depositOwner, 1),
                  revealDataWithNoLock.extraData,
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
            // The expected surplus (no transaction fee) is 1000 * 1e10 TBTC
            const expectedInitialDepositAmount = 200000000000000
            const expectedTbtcAmount = 184040000000000
            const expectedSurplus = 10000000000000

            const depositId = 1 // there is only one deposit

            before(async () => {
              await createSnapshot()

              tx = await bitcoinDepositor.finalizeDeposit(
                revealDataWithNoLock.depositKey,
                revealDataWithNoLock.depositOwner,
                revealDataWithNoLock.depositLockPeriod,
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositFinalized event", async () => {
              await expect(tx)
                .to.emit(bitcoinDepositor, "DepositFinalized")
                .withArgs(
                  revealDataWithNoLock.depositKey,
                  expectedInitialDepositAmount,
                  expectedTbtcAmount,
                )
            })

            it("should set the deposit state to Finalized", async () => {
              expect(
                await bitcoinDepositor.deposits(
                  revealDataWithNoLock.depositKey,
                ),
              ).to.equal(DepositState.Finalized)
            })

            it("should deposit tokens to the Portal contract", async () => {
              const { balance, unlockAt } = await portal.getDeposit(
                revealDataWithNoLock.depositOwner,
                tbtcAddress,
                depositId,
              )

              expect(balance).to.equal(expectedTbtcAmount)
              expect(unlockAt).to.equal(await helpers.time.lastBlockTime())
            })

            // See AbstractTBTCDepositor._calculateTbtcAmount docs
            it("should keep the surplus in the BitcoinDepositor contract", async () => {
              expect(await TBTC.balanceOf(bitcoinDepositorAddress)).to.equal(
                expectedSurplus,
              )
            })
          },
        )
      })

      context("when a single, lockable deposit was finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithLock.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataWithLock.depositKey)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when deposit owner param is different than during the initialization",
          () => {
            it("should revert", async () => {
              await expect(
                bitcoinDepositor.finalizeDeposit(
                  revealDataWithLock.depositKey,
                  thirdParty.address,
                  revealDataWithLock.depositLockPeriod,
                ),
              )
                .to.be.revertedWithCustomError(
                  bitcoinDepositor,
                  "UnexpectedExtraData",
                )
                .withArgs(
                  encodeExtraData(
                    thirdParty.address,
                    revealDataWithLock.depositLockPeriod,
                  ),
                  revealDataWithLock.extraData,
                )
            })
          },
        )

        context(
          "when deposit lock period param is different than during the initialization",
          () => {
            it("should revert", async () => {
              await expect(
                bitcoinDepositor.finalizeDeposit(
                  revealDataWithLock.depositKey,
                  revealDataWithLock.depositOwner,
                  revealDataWithLock.depositLockPeriod + 1,
                ),
              )
                .to.be.revertedWithCustomError(
                  bitcoinDepositor,
                  "UnexpectedExtraData",
                )
                .withArgs(
                  encodeExtraData(
                    revealDataWithLock.depositOwner,
                    revealDataWithLock.depositLockPeriod + 1,
                  ),
                  revealDataWithLock.extraData,
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
            // - Deposit amount = 10000 satoshi (hardcoded in funding transaction fixture)
            // - Treasury fee = 2% (default value used in MockBridge)
            // - Optimistic minting fee = 1% (default value used in MockTBTCVault)
            // - Transaction max fee = 1000 satoshi (default value used in MockBridge)
            //
            // ((10000 sat - 200 sat) * 0.99) - 1000 sat = 8702 sat = 8702 * 1e10 TBTC
            // The expected surplus (no transaction fee) is 1000 * 1e10 TBTC
            const expectedInitialDepositAmount = 100000000000000
            const expectedTbtcAmount = 87020000000000
            const expectedSurplus = 10000000000000

            const depositId = 1 // there is only one deposit

            before(async () => {
              await createSnapshot()

              tx = await bitcoinDepositor.finalizeDeposit(
                revealDataWithLock.depositKey,
                revealDataWithLock.depositOwner,
                revealDataWithLock.depositLockPeriod,
              )
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should emit DepositFinalized event", async () => {
              await expect(tx)
                .to.emit(bitcoinDepositor, "DepositFinalized")
                .withArgs(
                  revealDataWithLock.depositKey,
                  expectedInitialDepositAmount,
                  expectedTbtcAmount,
                )
            })

            it("should set the deposit state to Finalized", async () => {
              expect(
                await bitcoinDepositor.deposits(revealDataWithLock.depositKey),
              ).to.equal(DepositState.Finalized)
            })

            it("should deposit tokens to the Portal contract", async () => {
              const { balance, unlockAt } = await portal.getDeposit(
                revealDataWithLock.depositOwner,
                tbtcAddress,
                depositId,
              )

              expect(balance).to.equal(expectedTbtcAmount)
              expect(unlockAt).to.equal(
                (await helpers.time.lastBlockTime()) +
                  revealDataWithLock.depositLockPeriod,
              )
            })

            // See AbstractTBTCDepositor._calculateTbtcAmount docs
            it("should keep the surplus in the BitcoinDepositor contract", async () => {
              expect(await TBTC.balanceOf(bitcoinDepositorAddress)).to.equal(
                expectedSurplus,
              )
            })
          },
        )
      })

      context("when multiple deposits were finalized", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithNoLock.depositKey,
          )
          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithLock.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataWithNoLock.depositKey)
          await tbtcBridge.sweepDeposit(revealDataWithLock.depositKey)
        })

        after(async () => {
          await restoreSnapshot()
        })

        context(
          "when called with the same params as during the initialization",
          () => {
            let firstDepositBlockTime: number
            let secondDepositBlockTime: number

            // ((10000 sat - 200 sat) * 0.99) - 1000 sat = 8702 sat = 8702 * 1e10 TBTC
            const expectedFirstDepositTbtcAmount = 87020000000000
            // ((20000 sat * 0.98) * 0.99) - 1000 sat = 18404 sat = 18404 * 1e10 TBTC
            const expectedSecondDepositTbtcAmount = 184040000000000
            // Twice the transaction max fee = 1000 satoshi (default value used in MockBridge)
            const expectedSurplus = 20000000000000

            before(async () => {
              await createSnapshot()

              await bitcoinDepositor.finalizeDeposit(
                revealDataWithLock.depositKey,
                revealDataWithLock.depositOwner,
                revealDataWithLock.depositLockPeriod,
              )
              firstDepositBlockTime = await helpers.time.lastBlockTime()

              await bitcoinDepositor.finalizeDeposit(
                revealDataWithNoLock.depositKey,
                revealDataWithNoLock.depositOwner,
                revealDataWithNoLock.depositLockPeriod,
              )
              secondDepositBlockTime = await helpers.time.lastBlockTime()
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should set the states of deposits to Finalized", async () => {
              expect(
                await bitcoinDepositor.deposits(revealDataWithLock.depositKey),
              ).to.equal(DepositState.Finalized)
              expect(
                await bitcoinDepositor.deposits(
                  revealDataWithNoLock.depositKey,
                ),
              ).to.equal(DepositState.Finalized)
            })

            it("should deposit tokens to the Portal contract", async () => {
              const deposit1 = await portal.getDeposit(
                revealDataWithLock.depositOwner,
                tbtcAddress,
                1, // first deposit
              )

              const deposit2 = await portal.getDeposit(
                revealDataWithNoLock.depositOwner,
                tbtcAddress,
                2, // second deposit
              )

              expect(deposit1.balance).to.equal(expectedFirstDepositTbtcAmount)
              expect(deposit2.balance).to.equal(expectedSecondDepositTbtcAmount)
              expect(deposit1.unlockAt).to.equal(
                firstDepositBlockTime + revealDataWithLock.depositLockPeriod,
              )
              expect(deposit2.unlockAt).to.equal(secondDepositBlockTime)
            })

            // See AbstractTBTCDepositor._calculateTbtcAmount docs
            it("should keep the surplus in the BitcoinDepositor contract", async () => {
              expect(await TBTC.balanceOf(bitcoinDepositorAddress)).to.equal(
                expectedSurplus,
              )
            })
          },
        )
      })

      context("when called for the same deposit second time", () => {
        before(async () => {
          await createSnapshot()

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithLock.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataWithLock.depositKey)

          await bitcoinDepositor.finalizeDeposit(
            revealDataWithLock.depositKey,
            revealDataWithLock.depositOwner,
            revealDataWithLock.depositLockPeriod,
          )

          await tbtcVault.finalizeOptimisticMintingRequest(
            revealDataWithNoLock.depositKey,
          )
          await tbtcBridge.sweepDeposit(revealDataWithNoLock.depositKey)

          await bitcoinDepositor.finalizeDeposit(
            revealDataWithNoLock.depositKey,
            revealDataWithNoLock.depositOwner,
            revealDataWithNoLock.depositLockPeriod,
          )
        })

        after(async () => {
          await restoreSnapshot()
        })

        context("when called with the same params", () => {
          it("should revert", async () => {
            await expect(
              bitcoinDepositor.finalizeDeposit(
                revealDataWithLock.depositKey,
                revealDataWithLock.depositOwner,
                revealDataWithLock.depositLockPeriod,
              ),
            )
              .to.be.revertedWithCustomError(
                bitcoinDepositor,
                "UnexpectedDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)

            await expect(
              bitcoinDepositor.finalizeDeposit(
                revealDataWithNoLock.depositKey,
                revealDataWithNoLock.depositOwner,
                revealDataWithNoLock.depositLockPeriod,
              ),
            )
              .to.be.revertedWithCustomError(
                bitcoinDepositor,
                "UnexpectedDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)
          })
        })

        context("when called with different params", () => {
          it("should revert", async () => {
            await expect(
              bitcoinDepositor.finalizeDeposit(
                revealDataWithLock.depositKey,
                thirdParty.address,
                revealDataWithLock.depositLockPeriod,
              ),
            )
              .to.be.revertedWithCustomError(
                bitcoinDepositor,
                "UnexpectedDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)

            await expect(
              bitcoinDepositor.finalizeDeposit(
                revealDataWithNoLock.depositKey,
                revealDataWithNoLock.depositOwner,
                1,
              ),
            )
              .to.be.revertedWithCustomError(
                bitcoinDepositor,
                "UnexpectedDepositState",
              )
              .withArgs(DepositState.Finalized, DepositState.Initialized)
          })
        })
      })
    })
  })
})
