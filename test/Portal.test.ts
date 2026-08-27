import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers"
import { upgrades, helpers, ethers, getUnnamedAccounts } from "hardhat"
import { expect } from "chai"
import { ContractTransactionResponse, ZeroAddress } from "ethers"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { Portal } from "../typechain"
import deployPortal from "./fixtures/deployPortal"
import { TokenAbility } from "../types"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

describe("Portal - deployment and governance", () => {
  let tbtcAddress: string
  let wbtcAddress: string
  let usdcAddress: string
  let stbtcAddress: string
  let otherAddress: string
  let tokenWithoutDecimalsAddress: string
  let portal: Portal
  let deployer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let liquidityTreasuryMultisig: HardhatEthersSigner
  let tbtcMigrationTreasuryMultisig: HardhatEthersSigner
  let newLiquidityTreasuryMultisig: HardhatEthersSigner
  let newTbtcMigrationTreasuryMultisig: HardhatEthersSigner

  before(async () => {
    ;({
      tbtcAddress,
      wbtcAddress,
      usdcAddress,
      stbtcAddress,
      otherAddress,
      tokenWithoutDecimalsAddress,
      portal,
      deployer,
      thirdParty,
      liquidityTreasuryMultisig,
      tbtcMigrationTreasuryMultisig,
    } = await loadFixture(deployPortal))

    const unnamedAccounts = await getUnnamedAccounts()
    newLiquidityTreasuryMultisig = await ethers.getSigner(unnamedAccounts[90])
    newTbtcMigrationTreasuryMultisig = await ethers.getSigner(
      unnamedAccounts[91],
    )
  })

  describe("deployment", () => {
    context("when deployed with 0-address token", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          upgrades.deployProxy(
            await ethers.getContractFactory("Portal"),
            [[{ token: ZeroAddress, tokenAbility: TokenAbility.Deposit }]],
            {
              initializer: "initialize",
              kind: "transparent",
            },
          ),
        )
          .to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
          .withArgs(ZeroAddress)
      })
    })

    context("when deployed with supported tokens", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should deploy with 1 supported token ", async () => {
        const contract = (await upgrades.deployProxy(
          await ethers.getContractFactory("Portal"),
          [[{ token: tbtcAddress, tokenAbility: TokenAbility.Deposit }]],
          {
            initializer: "initialize",
            kind: "transparent",
          },
        )) as unknown as Portal

        expect(await contract.tokenAbility(tbtcAddress)).to.equal(
          TokenAbility.Deposit,
        )
        expect(await contract.tokenAbility(wbtcAddress)).to.equal(
          TokenAbility.None,
        )
      })

      it("should deploy with >1 supported tokens ", async () => {
        const contract = (await upgrades.deployProxy(
          await ethers.getContractFactory("Portal"),
          [
            [
              { token: tbtcAddress, tokenAbility: TokenAbility.DepositAndLock },
              { token: wbtcAddress, tokenAbility: TokenAbility.Deposit },
            ],
          ],
          {
            initializer: "initialize",
            kind: "transparent",
          },
        )) as unknown as Portal

        expect(await contract.tokenAbility(tbtcAddress)).to.equal(
          TokenAbility.DepositAndLock,
        )
        expect(await contract.tokenAbility(wbtcAddress)).to.equal(
          TokenAbility.Deposit,
        )
      })
    })
  })

  describe("addSupportedToken", () => {
    context("when called by non-owner", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).addSupportedToken({
            token: usdcAddress,
            tokenAbility: TokenAbility.Deposit,
          }),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by owner incorrectly", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("when adding 0-address token", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).addSupportedToken({
              token: ZeroAddress,
              tokenAbility: TokenAbility.Deposit,
            }),
          )
            .to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
            .withArgs(ZeroAddress)
        })
      })

      context("when adding already supported token", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).addSupportedToken({
              token: tbtcAddress,
              tokenAbility: TokenAbility.Deposit,
            }),
          )
            .to.be.revertedWithCustomError(portal, "TokenAlreadySupported")
            .withArgs(tbtcAddress, TokenAbility.DepositAndLock)
        })
      })

      context("when adding token that doesn't support decimals", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).addSupportedToken({
              token: tokenWithoutDecimalsAddress,
              tokenAbility: TokenAbility.Deposit,
            }),
          )
            .to.be.revertedWithCustomError(portal, "UnknownTokenDecimals")
            .withArgs(tokenWithoutDecimalsAddress)
        })
      })
    })

    context("when called by owner correctly", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()
        tx = await portal.connect(deployer).addSupportedToken({
          token: usdcAddress,
          tokenAbility: TokenAbility.Deposit,
        })
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a SupportedTokenAdded event", async () => {
        await expect(tx)
          .to.emit(portal, "SupportedTokenAdded")
          .withArgs(usdcAddress, TokenAbility.Deposit)
      })

      it("should update the supported tokens", async () => {
        expect(await portal.tokenAbility(wbtcAddress)).to.equal(
          TokenAbility.DepositAndLock,
        )
        expect(await portal.tokenAbility(tbtcAddress)).to.equal(
          TokenAbility.DepositAndLock,
        )
        expect(await portal.tokenAbility(usdcAddress)).to.equal(
          TokenAbility.Deposit,
        )
        expect(await portal.tokenAbility(otherAddress)).to.equal(
          TokenAbility.None,
        )
      })
    })
  })

  describe("setMinLockPeriod", () => {
    const newLockPeriod = 60 * 60 * 24 * 7 // 1 week

    context("when called by non-owner", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setMinLockPeriod(newLockPeriod),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by owner", () => {
      context("when called incorrectly", () => {
        context(
          "when trying to set min lock period greater than max lock period",
          () => {
            it("should revert", async () => {
              const maxLockPeriod = await portal.maxLockPeriod()

              await expect(
                portal.connect(deployer).setMinLockPeriod(maxLockPeriod + 1n),
              )
                .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
                .withArgs(maxLockPeriod + 1n)
            })
          },
        )

        context("when trying to set min lock period not normalized", () => {
          it("should revert", async () => {
            await expect(
              portal.connect(deployer).setMinLockPeriod(newLockPeriod + 1),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
              .withArgs(newLockPeriod + 1)
          })
        })

        // This is similar to the previous test but double-checks to-0
        // normalization is not extra treated in the contract.
        context(
          "when trying to set min lock period to value giving 0 post-normalization",
          () => {
            it("should revert", async () => {
              await expect(portal.connect(deployer).setMinLockPeriod(10))
                .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
                .withArgs(10)
            })
          },
        )

        context("when trying to set min lock period to 0", () => {
          it("should revert", async () => {
            await expect(portal.connect(deployer).setMinLockPeriod(0))
              .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
              .withArgs(0)
          })
        })
      })

      context("when called correctly", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()
          tx = await portal.connect(deployer).setMinLockPeriod(newLockPeriod)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit a MinLockPeriodUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "MinLockPeriodUpdated")
            .withArgs(newLockPeriod)
        })

        it("should update the min lock period", async () => {
          expect(await portal.minLockPeriod()).to.equal(newLockPeriod)
        })
      })
    })
  })

  describe("setMaxLockPeriod", () => {
    const newLockPeriod = 60 * 60 * 24 * 28 // 4 weeks

    context("when called by non-owner", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setMaxLockPeriod(newLockPeriod),
        ).to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
      })
    })

    context("when called by owner", () => {
      context("when called incorrectly", () => {
        context(
          "when trying to set max lock period less than min lock period",
          () => {
            it("should revert", async () => {
              const minLockPeriod = await portal.minLockPeriod()

              await expect(
                portal.connect(deployer).setMaxLockPeriod(minLockPeriod - 1n),
              )
                .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
                .withArgs(minLockPeriod - 1n)
            })
          },
        )

        context("when trying to set max lock period not normalized", () => {
          it("should revert", async () => {
            await expect(
              portal.connect(deployer).setMaxLockPeriod(newLockPeriod + 1),
            )
              .to.be.revertedWithCustomError(portal, "IncorrectLockPeriod")
              .withArgs(newLockPeriod + 1)
          })
        })
      })

      context("when called correctly", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()
          tx = await portal.connect(deployer).setMaxLockPeriod(newLockPeriod)
        })

        after(async () => {
          await restoreSnapshot()
        })
        it("should emit a MaxLockPeriodUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "MaxLockPeriodUpdated")
            .withArgs(newLockPeriod)
        })

        it("should update the max lock period", async () => {
          expect(await portal.maxLockPeriod()).to.equal(newLockPeriod)
        })
      })
    })
  })

  describe("setLiquidityTreasury", () => {
    context("when called by non-owner", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setLiquidityTreasury(otherAddress),
        )
          .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
          .withArgs(thirdParty.address)
      })
    })

    context("when called by owner", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()
        tx = await portal
          .connect(deployer)
          .setLiquidityTreasury(newLiquidityTreasuryMultisig.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a LiquidityTreasuryUpdated event", async () => {
        await expect(tx)
          .to.emit(portal, "LiquidityTreasuryUpdated")
          .withArgs(
            liquidityTreasuryMultisig.address,
            newLiquidityTreasuryMultisig.address,
          )
      })

      it("should update the liquidity treasury", async () => {
        expect(await portal.liquidityTreasury()).to.equal(
          newLiquidityTreasuryMultisig.address,
        )
      })
    })
  })

  describe("setAssetAsLiquidityTreasuryManaged", () => {
    before(async () => {
      await createSnapshot()

      await portal.setTbtcTokenAddress(tbtcAddress)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called incorrectly", () => {
      context("when called by a non-owner", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(thirdParty)
              .setAssetAsLiquidityTreasuryManaged(tbtcAddress, true),
          )
            .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
            .withArgs(thirdParty.address)
        })
      })

      context("when called by owner", () => {
        context(
          "when setting a non-supported token as liquidity treasury managed",
          () => {
            it("should revert", async () => {
              await expect(
                portal
                  .connect(deployer)
                  .setAssetAsLiquidityTreasuryManaged(ZeroAddress, true),
              )
                .to.be.revertedWithCustomError(portal, "TokenNotSupported")
                .withArgs(ZeroAddress)
            })
          },
        )

        context(
          "when setting a non-lockable asset as liquidity treasury managed",
          () => {
            before(async () => {
              await createSnapshot()
              await portal.connect(deployer).addSupportedToken({
                token: usdcAddress,
                tokenAbility: TokenAbility.Deposit,
              })
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                portal
                  .connect(deployer)
                  .setAssetAsLiquidityTreasuryManaged(usdcAddress, true),
              )
                .to.be.revertedWithCustomError(
                  portal,
                  "InsufficientTokenAbility",
                )
                .withArgs(usdcAddress, TokenAbility.Deposit)
            })
          },
        )

        context(
          "when setting a to-tBTC migratable asset as liquidity treasury managed",
          () => {
            before(async () => {
              await createSnapshot()

              await portal
                .connect(deployer)
                .setAssetTbtcMigrationAllowed(wbtcAddress, true)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                portal
                  .connect(deployer)
                  .setAssetAsLiquidityTreasuryManaged(wbtcAddress, true),
              ).to.be.revertedWithCustomError(
                portal,
                "TbtcMigrationAndLiquidityManagementConflict",
              )
            })
          },
        )
      })
    })

    context("when called correctly", () => {
      context("when called to SET asset as liquidity treasury managed", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()
          tx = await portal
            .connect(deployer)
            .setAssetAsLiquidityTreasuryManaged(tbtcAddress, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit a LiquidityTreasuryManagedAssetUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "LiquidityTreasuryManagedAssetUpdated")
            .withArgs(tbtcAddress, true)
        })

        it("should update the liquidity treasury managed assets", async () => {
          expect(
            await portal.liquidityTreasuryManaged(tbtcAddress),
          ).to.be.equal(true)
        })
      })

      context(
        "when called to UNSET asset as liquidity treasury managed",
        () => {
          let tx: ContractTransactionResponse

          before(async () => {
            await createSnapshot()

            await portal
              .connect(deployer)
              .setAssetAsLiquidityTreasuryManaged(tbtcAddress, true)

            tx = await portal
              .connect(deployer)
              .setAssetAsLiquidityTreasuryManaged(tbtcAddress, false)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should emit a LiquidityTreasuryManagedAssetUpdated event", async () => {
            await expect(tx)
              .to.emit(portal, "LiquidityTreasuryManagedAssetUpdated")
              .withArgs(tbtcAddress, false)
          })

          it("should update the liquidity treasury managed assets", async () => {
            expect(
              await portal.liquidityTreasuryManaged(tbtcAddress),
            ).to.be.equal(false)
          })
        },
      )
    })
  })

  describe("setTbtcTokenAddress", () => {
    context("when called incorrectly", () => {
      context("when called by non-owner", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(thirdParty).setTbtcTokenAddress(otherAddress),
          )
            .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
            .withArgs(thirdParty.address)
        })
      })

      context("when setting tBTC token address to zero", () => {
        it("should revert", async () => {
          await expect(
            portal.connect(deployer).setTbtcTokenAddress(ZeroAddress),
          )
            .to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
            .withArgs(ZeroAddress)
        })
      })

      context("when tBTC token address was already set", () => {
        before(async () => {
          await createSnapshot()

          await portal.connect(deployer).setTbtcTokenAddress(tbtcAddress)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          await expect(
            portal.connect(deployer).setTbtcTokenAddress(tbtcAddress),
          ).to.be.revertedWithCustomError(portal, "TbtcTokenAddressAlreadySet")
        })
      })
    })

    context("when called correctly", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()

        tx = await portal.connect(deployer).setTbtcTokenAddress(tbtcAddress)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit TbtcTokenAddressSet event", async () => {
        await expect(tx)
          .to.emit(portal, "TbtcTokenAddressSet")
          .withArgs(tbtcAddress)
      })

      it("should set the tBTC address in the contract", async () => {
        expect(await portal.tbtcToken()).to.equal(tbtcAddress)
      })
    })
  })

  describe("setTbtcMigrationTreasury", () => {
    context("when called by non-owner", () => {
      beforeEach(async () => {
        await createSnapshot()
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert", async () => {
        await expect(
          portal.connect(thirdParty).setTbtcMigrationTreasury(otherAddress),
        )
          .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
          .withArgs(thirdParty.address)
      })
    })

    context("when called by owner", () => {
      let tx: ContractTransactionResponse

      before(async () => {
        await createSnapshot()
        tx = await portal
          .connect(deployer)
          .setTbtcMigrationTreasury(newTbtcMigrationTreasuryMultisig.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a TbtcMigrationTreasuryUpdated event", async () => {
        await expect(tx)
          .to.emit(portal, "TbtcMigrationTreasuryUpdated")
          .withArgs(
            tbtcMigrationTreasuryMultisig.address,
            newTbtcMigrationTreasuryMultisig.address,
          )
      })

      it("should update the tBTC migration treasury", async () => {
        expect(await portal.tbtcMigrationTreasury()).to.equal(
          newTbtcMigrationTreasuryMultisig.address,
        )
      })
    })
  })

  describe("setAssetTbtcMigrationAllowed", () => {
    before(async () => {
      await createSnapshot()

      await portal.setTbtcTokenAddress(tbtcAddress)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when called incorrectly", () => {
      context("when called by a non-owner", () => {
        it("should revert", async () => {
          await expect(
            portal
              .connect(thirdParty)
              .setAssetTbtcMigrationAllowed(wbtcAddress, true),
          )
            .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
            .withArgs(thirdParty.address)
        })
      })

      context("when called by owner", () => {
        context(
          "when setting a non-supported token as tBTC migration-allowed",
          () => {
            it("should revert", async () => {
              await expect(
                portal
                  .connect(deployer)
                  .setAssetTbtcMigrationAllowed(thirdParty.address, true),
              )
                .to.be.revertedWithCustomError(portal, "TokenNotSupported")
                .withArgs(thirdParty.address)
            })
          },
        )

        context("when setting tBTC token as tBTC migration-allowed", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setAssetTbtcMigrationAllowed(tbtcAddress, true),
            ).to.be.revertedWithCustomError(portal, "TbtcCanNotBeMigrated")
          })
        })

        context(
          "when setting liquidity treasury managed token as tBTC-migration allowed",
          () => {
            before(async () => {
              await createSnapshot()

              await portal
                .connect(deployer)
                .setAssetAsLiquidityTreasuryManaged(wbtcAddress, true)
            })

            after(async () => {
              await restoreSnapshot()
            })

            it("should revert", async () => {
              await expect(
                portal
                  .connect(deployer)
                  .setAssetTbtcMigrationAllowed(wbtcAddress, true),
              ).to.be.revertedWithCustomError(
                portal,
                "TbtcMigrationAndLiquidityManagementConflict",
              )
            })
          },
        )
      })
    })

    context("when called correctly", () => {
      context("when called to set asset as tBTC migration-allowed", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()
          tx = await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit an TbtcMigrationAllowedUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "TbtcMigrationAllowedUpdated")
            .withArgs(wbtcAddress, true)
        })

        it("should update tBTC migration settings", async () => {
          const migrationInfo = await portal.tbtcMigrations(wbtcAddress)
          expect(migrationInfo.isAllowed).to.be.equal(true)
        })
      })

      context("when called to unset asset as tBTC migration-allowed", () => {
        let tx: ContractTransactionResponse

        before(async () => {
          await createSnapshot()

          await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, true)

          tx = await portal
            .connect(deployer)
            .setAssetTbtcMigrationAllowed(wbtcAddress, false)
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should emit an TbtcMigrationAllowedUpdated event", async () => {
          await expect(tx)
            .to.emit(portal, "TbtcMigrationAllowedUpdated")
            .withArgs(wbtcAddress, false)
        })

        it("should update tBTC migration settings", async () => {
          const migrationInfo = await portal.tbtcMigrations(wbtcAddress)
          expect(migrationInfo.isAllowed).to.be.equal(false)
        })
      })
    })
  })

  describe("setReceiptParams", () => {
    context("when called incorrectly", () => {
      context("when called by a non-owner", () => {
        before(async () => {
          await createSnapshot()
        })

        after(async () => {
          await restoreSnapshot()
        })

        it("should revert", async () => {
          expect(
            portal
              .connect(thirdParty)
              .setReceiptParams(tbtcAddress, 0, 0, stbtcAddress),
          )
            .to.be.revertedWithCustomError(portal, "OwnableUnauthorizedAccount")
            .withArgs(thirdParty.address)
        })
      })

      context("when called by owner", () => {
        context("when receipt token address is incorrect", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(tbtcAddress, 0, 90, ZeroAddress),
            ).to.be.revertedWithCustomError(portal, "IncorrectTokenAddress")
          })
        })

        context("when receipt token doesn't support decimals", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(
                  tbtcAddress,
                  0,
                  90,
                  tokenWithoutDecimalsAddress,
                ),
            ).to.be.revertedWithoutReason()
          })
        })

        context("when token isn't supported by Portal", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(otherAddress, 0, 0, stbtcAddress),
            )
              .to.be.revertedWithCustomError(portal, "TokenNotSupported")
              .withArgs(otherAddress)
          })
        })

        context("when the annual fee exceeds the max of 100%", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(tbtcAddress, 101, 0, stbtcAddress),
            )
              .to.be.revertedWithCustomError(portal, "MaxAnnualFeeExceeded")
              .withArgs(101)
          })
        })

        context("when the mint cap exceeds the max of 100%", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(tbtcAddress, 100, 101, stbtcAddress),
            )
              .to.be.revertedWithCustomError(
                portal,
                "MaxReceiptMintCapExceeded",
              )
              .withArgs(101)
          })
        })

        context("when receipt token is already initialized for token", () => {
          before(async () => {
            await createSnapshot()

            await portal
              .connect(deployer)
              .setReceiptParams(tbtcAddress, 0, 0, stbtcAddress)
          })

          after(async () => {
            await restoreSnapshot()
          })

          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(tbtcAddress, 0, 0, otherAddress),
            ).to.be.revertedWithCustomError(
              portal,
              "ReceiptTokenAlreadyInitialized",
            )
          })
        })

        context("when receipt token has incorrect decimals", () => {
          it("should revert", async () => {
            await expect(
              portal
                .connect(deployer)
                .setReceiptParams(tbtcAddress, 0, 90, wbtcAddress),
            ).to.be.revertedWithCustomError(
              portal,
              "IncorrectReceiptTokenDecimals",
            )
          })
        })
      })
    })

    context("when called correctly", () => {
      let tx: ContractTransactionResponse
      let timestamp: number

      before(async () => {
        await createSnapshot()
        tx = await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 1, 2, stbtcAddress)
        timestamp = await helpers.time.lastBlockTime()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a ReceiptParamsUpdated event", async () => {
        await expect(tx)
          .to.emit(portal, "ReceiptParamsUpdated")
          .withArgs(tbtcAddress, 1, 2, stbtcAddress)
      })

      it("should update the fee params", async () => {
        const feeInfo = await portal.feeInfo(tbtcAddress)

        expect(feeInfo.totalMinted).to.equal(0)
        expect(feeInfo.lastFeeUpdateAt).to.equal(timestamp)
        expect(feeInfo.feeIntegral).to.equal(0)
        expect(feeInfo.annualFee).to.equal(1)
        expect(feeInfo.mintCap).to.equal(2)
        expect(feeInfo.receiptToken).to.equal(stbtcAddress)
      })
    })

    context("when called to update params when already set", () => {
      let tx: ContractTransactionResponse
      let timestamp: number

      before(async () => {
        await createSnapshot()

        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 1, 2, stbtcAddress)

        tx = await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 3, 4, stbtcAddress)

        timestamp = await helpers.time.lastBlockTime()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should emit a ReceiptParamsUpdated event", async () => {
        await expect(tx)
          .to.emit(portal, "ReceiptParamsUpdated")
          .withArgs(tbtcAddress, 3, 4, stbtcAddress)
      })

      it("should update the receipt params", async () => {
        const feeInfo = await portal.feeInfo(tbtcAddress)

        expect(feeInfo.totalMinted).to.equal(0)
        expect(feeInfo.lastFeeUpdateAt).to.equal(timestamp)
        // feeIntegral will be non-zero given we updated the annual fee.
        // Leaving asserting a concrete value to other tests in this file.
        expect(feeInfo.feeIntegral).to.not.equal(0)
        expect(feeInfo.annualFee).to.equal(3)
        expect(feeInfo.mintCap).to.equal(4)
        expect(feeInfo.receiptToken).to.equal(stbtcAddress)
      })
    })

    context("when called to update params with non-zero annual fee", () => {
      before(async () => {
        await createSnapshot()

        // 0% initially
        await portal
          .connect(deployer)
          .setReceiptParams(tbtcAddress, 0, 0, stbtcAddress)
      })

      after(async () => {
        await restoreSnapshot()
      })

      context("for the first update", () => {
        before(async () => {
          await helpers.time.increaseTime(30 * 86400) // 30 days

          // increase to 10%
          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 10, 0, stbtcAddress)
        })

        it("should update the fee integral", async () => {
          const feeInfo = await portal.feeInfo(tbtcAddress)
          const lastBlockTime = await helpers.time.lastBlockTime()

          // The fee was 0% annually so the integral should also be zero for
          // that one month that passed.
          expect(feeInfo.annualFee).to.equal(10)
          expect(feeInfo.feeIntegral).to.equal(0)
          expect(feeInfo.lastFeeUpdateAt).to.equal(lastBlockTime)
        })
      })

      context("for the second update", () => {
        before(async () => {
          await helpers.time.increaseTime(30 * 86400) // 30 days

          // increase to 20%
          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 20, 0, stbtcAddress)
        })

        it("should update the fee integral", async () => {
          const feeInfo = await portal.feeInfo(tbtcAddress)
          const lastBlockTime = await helpers.time.lastBlockTime()

          // 10^18 / (365 * 86400) is a base rate in tokens per second
          // the annual fee was 10%, so we multiply it by 0.1. This is how
          // many tokens should be cut as a fee every second. This was valid
          // for 30 days, until the fee was increased to 20%. So the integral
          // so far (token units per second) should be:
          // [10^18 / (365 * 86400)] * 0.1 * 30 * 86400 = 8219178082191781
          //
          // Given Hardhat specifics, the setReceiptParams transaction setting
          // 20% fee will be mined next second after we increased the time by
          // 30 days. Also, there is a limited precision on computing decimals.
          // This all has to be taken into account when asserting the value.
          //
          // Fee rate: [10^18 / (365 * 86400)] * 0.1 = 3170979198
          //
          // This is the amount of tokens accrued as a fee every second in
          // 1e18 precision.
          //
          // Time interval: 30 * 86400 + 1 = 2592001
          //
          // The time period for the 10% fee was one week. Given Hardhat
          // specifics, the setReceiptParams transaction setting 20% fee is
          // mined the next second after we increased the time by 30 days,
          // so the time interval.
          //
          // Thus, the fee integral should be:
          // 2592001 * 3170979198 = 8219181252195198
          expect(feeInfo.annualFee).to.equal(20)
          expect(feeInfo.feeIntegral).to.equal(8219181252195198n)
          expect(feeInfo.lastFeeUpdateAt).to.equal(lastBlockTime)
        })
      })

      context("for the third update", () => {
        before(async () => {
          await helpers.time.increaseTime(60 * 86400) // 60 days

          // decrease to 0%
          await portal
            .connect(deployer)
            .setReceiptParams(tbtcAddress, 0, 0, stbtcAddress)
        })

        it("should update the fee integral", async () => {
          const feeInfo = await portal.feeInfo(tbtcAddress)
          const lastBlockTime = await helpers.time.lastBlockTime()

          // Fee rate: [10^18 / (365 * 86400)] * 0.2 = 6341958396
          // Time interval: 60 * 86400 + 1 = 5184001
          // 6341958396 * 5184001 + 8219181252195198 = 41095899919017594
          expect(feeInfo.annualFee).to.equal(0)
          expect(feeInfo.feeIntegral).to.equal(41095899919017594n)
          expect(feeInfo.lastFeeUpdateAt).to.equal(lastBlockTime)
        })
      })
    })
  })
})
