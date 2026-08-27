// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@keep-network/tbtc-v2/contracts/integrator/AbstractTBTCDepositor.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./Portal.sol";

/// @notice BitcoinDepositor contract holds the logic required to handle Bitcoin
///         deposits into the Portal contract.
///         The Bitcoin deposit has to be performed in two steps from the
///         perspective of the Portal contract.
///
///         In the first step, the P2(W)SH Bitcoin deposit transaction is
///         revealed to the tBTC bridge. This allows the tBTC bridge to mint the
///         token on Ethereum, with optimistic minting or periodic sweeping.
///         The ERC20 tBTC token is minted to the BitcoinDepositor contract
///         address - the one that revealed the deposit to tBTC bridge and the
///         one that is embedded in the P2(W)SH Bitcoin deposit script. This
///         step is implemented by the `initializeDeposit` function.
///
///         In the second step, the tBTC minted must be deposited to the Portal
///         contract using the Ethereum address of the real depositor that was
///         embedded in the P2(W)SH Bitcoin deposit script. This step is
///         implemented by the `finalizeDeposit` function.
///
///         Note that those two steps can not be done together as tBTC ERC20
///         token minting must happen between the two of them.
/// @dev The contract is supposed to be deployed behind a transparent
///      upgradeable proxy.
contract BitcoinDepositor is AbstractTBTCDepositor, Initializable {
    using SafeERC20 for IERC20;

    /// @notice Reflects the deposit state:
    ///         - Unknown deposit has not been initialized yet.
    ///         - Initialized deposit has been initialized with a call to
    ///           `initializeDeposit` function and is known to this contract.
    ///         - Finalized deposit led to tBTC ERC20 minting and was finalized
    ///           with a call to `finalizeDeposit` function that deposited tBTC
    ///           to the Portal contract.
    enum DepositState {
        Unknown,
        Initialized,
        Finalized
    }

    /// @notice Reference to the Mezo Portal contract.
    Portal public portal;

    /// @notice Reference to the tBTC ERC20 token contract.
    IERC20 public tbtcToken;

    /// @notice Holds the deposit state, keyed by the deposit key calculated for
    ///         the individual deposit during the call to `initializeDeposit`
    ///         function.
    mapping(uint256 => DepositState) public deposits;

    event DepositInitialized(
        uint256 indexed depositKey,
        address indexed depositOwner,
        uint256 depositLockPeriod
    );

    event DepositFinalized(
        uint256 indexed depositKey,
        uint256 initialAmount,
        uint256 tbtcAmount
    );

    /// @notice Function reverts with this error if the deposit state is not as
    ///         expected. `initializeDeposit` can only be called for `Unknown`
    ///         deposits. `finalizeDeposit` can only be called for `Initialized`
    ///         deposits.
    error UnexpectedDepositState(
        DepositState actualState,
        DepositState expectedState
    );

    /// @notice `finalizeDeposit` reverts with this error if the `depositOwner`
    ///         and/or `depositLockPeriod` passed as the parameters are not
    ///         the same as passed earlier to the `initializeDeposit`.
    error UnexpectedExtraData(
        bytes32 actualExtraData,
        bytes32 expectedExtraData
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract with the appropriate external contract
    ///         addresses.
    /// @dev All addresses passed to the contract must not be 0x0.
    /// @param _bridge Address to the tBTC Bridge contract.
    /// @param _tbtcVault Address to the tBTC TBTCVault contract.
    /// @param _tbtcToken Address to the tBTC ERC20 token contract.
    /// @param _portal Address to the Mezo Portal contract.
    function initialize(
        address _bridge,
        address _tbtcVault,
        address _tbtcToken,
        address _portal
    ) external initializer {
        __AbstractTBTCDepositor_initialize(_bridge, _tbtcVault);

        require(_tbtcToken != address(0), "tBTC token address cannot be zero");
        tbtcToken = IERC20(_tbtcToken);

        require(
            _portal != address(0),
            "Portal contract address cannot be zero"
        );
        portal = Portal(_portal);
    }

    /// @notice Initializes the deposit process after the Bitcoin P2(W)SH deposit
    ///         transaction is performed. Reveals the deposit to tBTC bridge and
    ///         marks the deposit as initialized internally. Once tBTC minting
    ///         is completed, this call should be followed by a call to
    ///         `finalizeDeposit`. The P2(W)SH Bitcoin script depositing tokens
    ///         should have the following format:
    ///
    ///         <depositor-address> DROP
    ///         <depositor-extra-data> DROP
    ///         <blinding-factor> DROP
    ///         DUP HASH160 <signingGroupPubkeyHash> EQUAL
    ///         IF
    ///           CHECKSIG
    ///         ELSE
    ///           DUP HASH160 <refundPubkeyHash> EQUALVERIFY
    ///           <locktime> CHECKLOCKTIMEVERIFY DROP
    ///           CHECKSIG
    ///         ENDIF
    ///
    ///         Where:
    ///
    ///         <depositor-address> 20-byte Ethereum address of the
    ///         BitcoinDepositor contract.
    ///
    ///         <depositor-extra-data> 32-byte keccak256 hash of abi-encoded
    ///         deposit owner address and deposit lock time in seconds,
    ///         normalized to weeks. If there should be no lock applied to the
    ///         deposit, the value should be 0.
    ///
    ///         <blinding-factor> 8-byte deposit blinding factor, as used in the
    ///         tBTC bridge
    ///
    ///         <signingGroupPubkeyHash> The compressed Bitcoin public key (33
    ///         bytes and 02 or 03 prefix) of the deposit's wallet hashed in the
    ///         HASH160 Bitcoin opcode style. This must point to the active tBTC
    ///         bridge wallet.
    ///
    ///         <refundPubkeyHash> The compressed Bitcoin public key (33 bytes
    ///         and 02 or 03 prefix) that can be used to make the deposit refund
    ///         after the tBTC bridge refund locktime passed. Hashed in the
    ///         HASH160 Bitcoin opcode style. This is needed only as a security
    ///         measure protecting the user in case tBTC bridge completely stops
    ///         functioning.
    ///
    ///         <locktime> The Bitcoin script refund locktime (4-byte LE),
    ///         according to tBTC bridge rules. __This is NOT the same locktime
    ///         as the one used for the Mezo deposit.__
    ///
    ///         Please consult tBTC Bridge.revealDepositWithExtraData function
    ///         documentation for more information.
    /// @dev Requirements:
    ///      - The deposit owner and depositLockPeriod must be represented in
    ///        the Bitcoin deposit P2(W)SH script in the <depositor-extra-data>
    ///        value. If the value in the Bitcoin script and the values passed
    ///        as the parameters do not match, the function will revert.
    ///      - The function can be called only one time for the given P2(W)SH
    ///        Bitcoin deposit transaction.
    ///      - All the requirements of tBTC Bridge.revealDepositWithExtraData
    ///        must be met.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`
    /// @param reveal Deposit reveal data, see `RevealInfo struct.
    /// @param depositOwner The address of the account that should own the
    ///        deposit.
    /// @param depositLockPeriod The deposit lock period in seconds, normalized
    ///        to weeks. 0 if there should be no lock time.
    function initializeDeposit(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        address depositOwner,
        uint32 depositLockPeriod
    ) external {
        require(depositOwner != address(0), "Deposit owner must not be 0x0");

        (uint256 depositKey, ) = _initializeDeposit(
            fundingTx,
            reveal,
            keccak256(abi.encode(depositOwner, depositLockPeriod))
        );

        if (deposits[depositKey] != DepositState.Unknown) {
            revert UnexpectedDepositState(
                deposits[depositKey],
                DepositState.Unknown
            );
        }

        deposits[depositKey] = DepositState.Initialized;

        emit DepositInitialized(depositKey, depositOwner, depositLockPeriod);
    }

    /// @notice Finalizes the deposit process by depositing tBTC ERC20 token to
    ///         the Portal contract. This function should be called after the
    ///         deposit was initialized with a call to `initializeDeposit`
    ///         function and after tBTC ERC20 token was minted by the bridge to
    ///         the BitcoinDepositor contract.
    ///         Please note several hours may pass between `initializeDeposit`
    ///         and `finalizeDeposit`.
    /// @dev Requirements:
    ///      - `initializeDeposit` was called for the given deposit before.
    ///      - tBTC ERC20 was minted by tBTC Bridge to this contract.
    ///      - The function was not called for the given deposit before.
    ///      - The same `depositOwner` and `depositLockPeriod` were passed when
    ///        initiating the deposit.
    /// @param depositKey The deposit key, as emitted in the `DepositInititiated`
    ///        event emitted by the `initializeDeposit` function for the deposit.
    /// @param depositOwner The address of the account that should own the
    ///        deposit. This must be the same value as passed to
    ///        `initializeDeposit` for the deposit.
    /// @param depositLockPeriod The deposit lock period in seconds, normalized
    ///        to weeks. 0 if there should be no lock time. This must be the
    ///        same value as passed to `initializeDeposit` for the deposit.
    function finalizeDeposit(
        uint256 depositKey,
        address depositOwner,
        uint32 depositLockPeriod
    ) external {
        if (deposits[depositKey] != DepositState.Initialized) {
            revert UnexpectedDepositState(
                deposits[depositKey],
                DepositState.Initialized
            );
        }

        deposits[depositKey] = DepositState.Finalized;

        (
            uint256 initialDepositAmount,
            uint256 tbtcAmount,
            bytes32 expectedExtraData
        ) = _finalizeDeposit(depositKey);

        bytes32 actualExtraData = keccak256(
            abi.encode(depositOwner, depositLockPeriod)
        );
        if (actualExtraData != expectedExtraData) {
            revert UnexpectedExtraData(actualExtraData, expectedExtraData);
        }

        tbtcToken.safeIncreaseAllowance(address(portal), tbtcAmount);
        portal.depositFor(
            depositOwner,
            address(tbtcToken),
            uint96(tbtcAmount),
            depositLockPeriod
        );

        emit DepositFinalized(depositKey, initialDepositAmount, tbtcAmount);
    }
}
