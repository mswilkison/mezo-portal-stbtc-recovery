// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@keep-network/tbtc-v2/contracts/integrator/AbstractTBTCDepositor.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IERC20WithPermit.sol";

/// @notice BitcoinBridge abstract contract exposes the capability of bridging
///         Bitcoin (using tBTC) from Ethereum to the Mezo chain.
///         The process can be achieved in one of two ways:
///         - Depositing: which is used when the user does not yet have tBTC.
///           In this case the user needs to create a Bitcoin transaction with
///           a specific format and use `initializeBTCBridging` and
///           `finalizeBTCBridging` functions,
///         - Bridging: which is used when the user already has tBTC on Ethereum
///           and would like to bridge it to Mezo. In this case either
///          `bridgeTBTC` or `bridgeTBTCWithPermit` must be used.
/// @dev The contract is supposed to be extended by the MezoBridge contract.
abstract contract BitcoinBridge is
    AbstractTBTCDepositor,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Reflects the BTC deposit state:
    ///         - Unknown deposit has not been initialized yet.
    ///         - Initialized deposit has been initialized with a call to
    ///           `initializeBTCBridging` function and is known to this contract.
    ///         - Finalized deposit led to tBTC ERC20 minting and was finalized
    ///           with a call to `finalizeBTCBridging` function. Deposit
    ///           finalizing leads to tBTC being bridged to the Mezo chain.
    enum BTCDepositState {
        Unknown,
        Initialized,
        Finalized
    }

    /// @notice Reference to the tBTC ERC20 token contract.
    address public tbtcToken;

    /// @notice Holds the BTC deposit state, keyed by the deposit key calculated for
    ///         the individual deposit during the call to `initializeBTCBridging`
    ///         function.
    mapping(uint256 => BTCDepositState) public btcDeposits;

    /// @notice Minimum amount of tBTC that can be bridged using `bridgeTBTC`
    ///         and `bridgeTBTCWithPermit`. It helps to prevent DoS attacks.
    ///         Its value is in tBTC precision. Note that `initializeBTCBridging`
    ///         does not enforce this limit, as the tBTC bridge already has its
    ///         own minimum deposit requirement, which provides adequate
    ///         protection against DoS attacks.
    uint256 public minTBTCAmount;

    // Reserved storage space that allows adding more variables without affecting
    // the storage layout of the child contracts. The convention from OpenZeppelin
    // suggests the storage space should add up to 50 slots. If more variables are
    // added in the upcoming versions one need to reduce the array size accordingly.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[47] private __gap;

    event BTCDepositInitialized(
        uint256 indexed btcDepositKey,
        address indexed recipient
    );

    event BTCDepositFinalized(
        uint256 indexed btcDepositKey,
        uint256 initialAmount,
        uint256 tbtcAmount
    );

    event MinTBTCAmountUpdated(uint256 minTBTCAmount);

    error MinTBTCAmountIsZero();

    error BTCRecipientIsZeroAddress();

    error TBTCTokenIsZeroAddress();

    error AmountBelowMinTBTCAmount();

    /// @notice Function reverts with this error if the BTC deposit state is not as
    ///         expected. `initializeBTCBridging` can only be called for
    ///         `Unknown` deposits. `finalizeBTCBridging` can only be called
    ///         for `Initialized` deposits.
    error UnexpectedBTCDepositState(
        BTCDepositState actualState,
        BTCDepositState expectedState
    );

    /// @notice `finalizeBTCBridging` reverts with this error if the
    ///         `recipient` passed as the parameters is not the same as passed
    ///         earlier to the `initializeBTCBridging`.
    error UnexpectedExtraData(
        bytes32 actualExtraData,
        bytes32 expectedExtraData
    );

    /// @notice Bridges the `amount` of the `token` to the `recipient` address on Mezo.
    /// @param recipient Recipient of the bridged token.
    /// @param token Address of the bridged token.
    /// @param amount Amount of the bridged token.
    function _bridge(
        address recipient,
        address token,
        uint256 amount
    ) internal virtual;

    /// @notice Initializes the contract.
    /// @dev All addresses passed to the contract must not be 0x0.
    /// @param _tbtcBridge Address to the tBTC Bridge contract.
    /// @param _tbtcVault Address to the tBTC TBTCVault contract.
    /// @param _tbtcToken Address to the tBTC ERC20 token contract.
    function __BitcoinBridge_initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _tbtcToken
    ) internal {
        __AbstractTBTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        // Note that initializers of OZ upgradeable contracts are not linearized
        // by the compiler like constructors. Therefore, if __BitcoinBridge_initialize
        // is called from within a child contract's initializer that also calls
        // __Ownable_init and __ReentrancyGuard_init somewhere else in the
        // inheritance chain, the Ownable and ReentrancyGuard initializers will
        // be called twice (it's actually the case for the MezoBridge child contract).
        // Although this is not a problem with currently used OZ version where
        // __Ownable_init and __ReentrancyGuard_init are idempotent
        // (as long as __Ownable_init is called with the same argument),
        // it's worth noting this caveat for future.
        //
        // For reference, see the following OZ documentation:
        // https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable/blob/v5.0.2/docs/modules/ROOT/pages/upgradeable.adoc#multiple-inheritance
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();

        if (_tbtcToken == address(0)) {
            revert TBTCTokenIsZeroAddress();
        }
        tbtcToken = _tbtcToken;

        minTBTCAmount = 0.01 * 1e18; // 0.01 BTC
    }

    /// @notice Updates the minimum tBTC amount allowed to be bridged using
    ///         `bridgeTBTC` and `bridgeTBTCWithPermit`.
    /// @param newMinTBTCAmount New minimum tBTC amount (in tBTC precision).
    ///                         Must be positive.
    /// @dev Access restricted with the `onlyOwner` modifier.
    function updateMinTBTCAmount(uint256 newMinTBTCAmount) external onlyOwner {
        if (newMinTBTCAmount == 0) {
            revert MinTBTCAmountIsZero();
        }

        minTBTCAmount = newMinTBTCAmount;

        emit MinTBTCAmountUpdated(newMinTBTCAmount);
    }

    /// @notice Transfers and locks the `amount` of tBTC in the contract and
    ///         calls `_bridge` function thus initiating bridging to Mezo to
    ///         the `recipient` address.
    /// @param amount Amount of tBTC to be bridged.
    /// @param recipient Recipient of the bridged tBTC.
    /// @dev Requirements:
    ///     - The amount must be equal to or greater than the minimum tBTC
    ///       amount allowed to be bridged.
    ///     - The tBTC is transferred using the allowance mechanism. The caller
    ///       must ensure the appropriate amount of tBTC is approved for the
    ///      `BitcoinBridge` contract.
    function bridgeTBTC(
        uint256 amount,
        address recipient
    ) external nonReentrant {
        _bridgeTBTC(amount, recipient);
    }

    /// @notice Private function holding the actual logic for the external
    ///         non-reentrant `bridgeTBTC` function. This function allows
    ///         reusing TBTC bridging logic from another external non-reentrant
    ///         function - `bridgeTBTCWithPermit`. This wouldn't be possible
    ///         without the `_bridgeTBTC` function, as non-reentrant functions
    ///         cannot call themselves.
    function _bridgeTBTC(uint256 amount, address recipient) private {
        if (recipient == address(0)) {
            revert BTCRecipientIsZeroAddress();
        }

        if (amount < minTBTCAmount) {
            revert AmountBelowMinTBTCAmount();
        }

        // Get tbtcToken from storage only once to save gas.
        address _tbtcToken = tbtcToken;

        _bridge(recipient, _tbtcToken, amount);

        IERC20(_tbtcToken).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Transfers and locks the `amount` of tBTC in the contract and
    ///         calls `_bridge` function thus initializing bridging to Mezo to
    ///         the `recipient` address. If the caller has not approved enough
    ///         tBTC for the `BitcoinBridge` contract, it also increases the
    ///         allowance using the EIP2612 permit functionality.
    /// @dev This function can achieve the same result as `bridgeTBTC`, but
    ///      it does not have to be preceded with a separate transaction
    ///      approving tBTC.
    ///      Requirements:
    ///      - must be called by the same address that generated the signature,
    ///      - the `amount` and `deadline` must be the same as used during the
    ///        signature generation and `v`, `r`, `s` parameters must represent
    ///        a valid signature.
    /// @param amount Amount of tBTC to be bridged.
    /// @param recipient Recipient of the bridged tBTC.
    /// @param deadline EIP2612 deadline
    /// @param v EIP2612 signature v
    /// @param r EIP2612 signature r
    /// @param s EIP2612 signature s
    function bridgeTBTCWithPermit(
        uint256 amount,
        address recipient,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        // If allowance is sufficient, we can fallback to the regular
        // `bridgeTBTC` call. This is also a protection in case someone
        // front-runned the `bridgeTBTCWithPermit` call and already executed
        // permit on the `tbtcToken` contract.
        if (IERC20(tbtcToken).allowance(msg.sender, address(this)) < amount) {
            IERC20WithPermit(tbtcToken).permit(
                msg.sender,
                address(this),
                amount,
                deadline,
                v,
                r,
                s
            );
        }

        _bridgeTBTC(amount, recipient);
    }

    /// @notice Initializes the BTC deposit process after the Bitcoin P2(W)SH deposit
    ///         transaction is performed. Reveals the deposit to tBTC bridge and
    ///         marks the deposit as initialized internally. Once tBTC minting
    ///         is completed, this call should be followed by a call to
    ///         `finalizeBTCBridging`. The P2(W)SH Bitcoin script depositing
    ///         tokens should have the following format:
    ///
    ///         <bridge-address> DROP
    ///         <recipient-extra-data> DROP
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
    ///         <bridge-address> 20-byte Ethereum address of the BitcoinBridge
    ///         contract.
    ///
    ///         <recipient-extra-data> 32-byte keccak256 hash of abi-encoded
    ///         recipient address.
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
    ///         according to tBTC bridge rules.
    ///
    ///         Please consult tBTC Bridge.revealDepositWithExtraData function
    ///         documentation for more information.
    /// @dev IMPORTANT NOTE: The amount of tBTC bridged to the Mezo chain may
    ///      not correspond to the actual amount of tBTC minted for the deposit.
    ///      The reason for this is that the fees for optimistic minting and
    ///      Bitcoin transaction are not known precisely upon minting. For the
    ///      great majority of deposits, slightly less tBTC will be bridged and
    ///      the surplus of tBTC will remain in the `BitcoinBridge` contract.
    ///      For a detailed explanation see `_calculateTbtcAmount` from the
    ///      `AbstractTBTCDepositor` contract.
    ///      Requirements:
    ///      - The recipient address must be represented in the Bitcoin deposit
    ///        P2(W)SH script in the <recipient-extra-data>. If the value in the
    ///        Bitcoin script and the value passed as the parameters do not
    ///        match, the function will revert.
    ///      - The function can be called only one time for the given P2(W)SH
    ///        Bitcoin deposit transaction.
    ///      - All the requirements of tBTC Bridge.revealDepositWithExtraData
    ///        must be met.
    /// @param fundingTx Bitcoin funding transaction data, see `BitcoinTx.Info`
    /// @param reveal Deposit reveal data, see `RevealInfo` struct.
    /// @param recipient Recipient of the bridged tBTC in Mezo.
    function initializeBTCBridging(
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        address recipient
    ) external {
        if (recipient == address(0)) {
            revert BTCRecipientIsZeroAddress();
        }

        // Store `keccak256` of the recipient address rather than the recipient
        // address in extra data. This gives us the flexibility to add new
        // parameters in the future.
        (uint256 btcDepositKey, ) = _initializeDeposit(
            fundingTx,
            reveal,
            keccak256(abi.encode(recipient))
        );

        if (btcDeposits[btcDepositKey] != BTCDepositState.Unknown) {
            revert UnexpectedBTCDepositState(
                btcDeposits[btcDepositKey],
                BTCDepositState.Unknown
            );
        }

        btcDeposits[btcDepositKey] = BTCDepositState.Initialized;

        emit BTCDepositInitialized(btcDepositKey, recipient);
    }

    /// @notice Finalizes the BTC deposit process by locking tBTC ERC20 token to
    ///         the `BitcoinBridge` contract and calling `_bridge` function
    ///         thus initiating bridging to the Mezo chain. This function should
    ///         be called after the deposit was initialized with a call to
    ///         `initializeBTCBridging` function and after tBTC ERC20 token
    ///         was minted by the bridge to the `BitcoinBridge` contract.
    ///         Please note several hours may pass between `initializeBTCBridging`
    ///         and `finalizeBTCBridging`.
    /// @dev Requirements:
    ///      - `initializeBTCBridging` was called for the given deposit before.
    ///      - tBTC ERC20 was minted by tBTC Bridge to this contract.
    ///      - The function was not called for the given deposit before.
    ///      - The same `recipient` address was passed when initiating the
    ///        deposit.
    /// @param btcDepositKey The BTC deposit key, as emitted in the `BTCDepositInitialized`
    ///        event emitted by the `initializeBTCBridging` function for the deposit.
    /// @param recipient The address of the account that should own the
    ///        deposit. This must be the same value as passed to
    ///        `initializeBTCBridging` for the deposit.
    function finalizeBTCBridging(
        uint256 btcDepositKey,
        address recipient
    ) external {
        if (btcDeposits[btcDepositKey] != BTCDepositState.Initialized) {
            revert UnexpectedBTCDepositState(
                btcDeposits[btcDepositKey],
                BTCDepositState.Initialized
            );
        }

        btcDeposits[btcDepositKey] = BTCDepositState.Finalized;

        (
            uint256 initialDepositAmount,
            uint256 tbtcAmount,
            bytes32 expectedExtraData
        ) = _finalizeDeposit(btcDepositKey);

        bytes32 actualExtraData = keccak256(abi.encode(recipient));

        if (actualExtraData != expectedExtraData) {
            revert UnexpectedExtraData(actualExtraData, expectedExtraData);
        }

        emit BTCDepositFinalized(
            btcDepositKey,
            initialDepositAmount,
            tbtcAmount
        );

        _bridge(recipient, tbtcToken, tbtcAmount);
    }
}
