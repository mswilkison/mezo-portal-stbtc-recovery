// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @notice ERC20Bridge abstract contract exposes the capability of bridging
///         ERC20 tokens from Ethereum to the Mezo chain.
/// @dev The contract is supposed to be extended by the MezoBridge contract.
abstract contract ERC20Bridge is
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Maximum number of distinct ERC20 tokens that can be enabled
    ///         in the bridge.
    /// @dev The reason for this limit is to not downgrade the bridge
    ///      performance on the Mezo chain side too much.
    uint256 public constant MAX_ERC20_TOKENS = 20;

    /// @notice Count of ERC20 tokens enabled in the bridge.
    uint256 public ERC20TokensCount;

    /// @notice Mapping of ERC20 tokens to their minimum bridgeable amounts,
    ///         in the token precision.
    mapping(address => uint256) public ERC20Tokens;

    // Reserved storage space that allows adding more variables without affecting
    // the storage layout of the child contracts. The convention from OpenZeppelin
    // suggests the storage space should add up to 50 slots. If more variables are
    // added in the upcoming versions one need to reduce the array size accordingly.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[48] private __gap;

    event ERC20TokenEnabled(address indexed ERC20Token, uint256 minERC20Amount);

    event ERC20TokenDisabled(address indexed ERC20Token);

    event MinERC20AmountUpdated(
        address indexed ERC20Token,
        uint256 newMinERC20Amount
    );

    error MinERC20AmountIsZero();

    error ERC20TokenIsZeroAddress();

    error ERC20TokenAlreadyEnabled();

    error MaxERC20TokensReached();

    error ERC20TokenNotEnabled();

    error ERC20RecipientIsZeroAddress();

    error AmountBelowMinERC20Amount();

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
    function __ERC20Bridge_initialize() internal {
        // Note that initializers of OZ upgradeable contracts are not linearized
        // by the compiler like constructors. Therefore, if __ERC20Bridge_initialize
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

        // Just in case.
        ERC20TokensCount = 0;
    }

    /// @notice Enables bridging support for the given ERC20 token, with the given
    ///         minimum bridgeable amount.
    /// @param ERC20Token Address of the ERC20 token to be enabled.
    /// @param minERC20Amount Minimum amount of the ERC20 token that can be bridged,
    ///                       in the token precision.
    /// @dev Requirements:
    ///      - Access restricted with the `onlyOwner` modifier,
    ///      - The ERC20 token must not be the zero address,
    ///      - The minimum ERC20 amount must be positive,
    ///      - The ERC20 token must not be already enabled,
    ///      - The maximum number of ERC20 tokens must not be reached.
    ///
    /// @dev BEWARE!!! BEFORE ENABLING AN ERC20 TOKEN USING THIS FUNCTION,
    ///      MAKE SURE THE CORRECT MAPPING FOR THIS TOKEN EXISTS ON THE
    ///      MEZO CHAIN. OTHERWISE, THE BRIDGE WILL IGNORE THE BRIDGING REQUESTS
    ///      FOR THIS TOKEN. THE AMOUNT BRIDGED WILL BE LOCKED ON THIS
    ///      CONTRACT AND NO TOKENS WILL BE ISSUED ON THE MEZO CHAIN.
    function enableERC20Token(
        address ERC20Token,
        uint256 minERC20Amount
    ) external onlyOwner {
        if (ERC20Token == address(0)) {
            revert ERC20TokenIsZeroAddress();
        }

        if (minERC20Amount == 0) {
            revert MinERC20AmountIsZero();
        }

        if (ERC20Tokens[ERC20Token] != 0) {
            revert ERC20TokenAlreadyEnabled();
        }

        if (ERC20TokensCount >= MAX_ERC20_TOKENS) {
            revert MaxERC20TokensReached();
        }

        ERC20TokensCount++;
        ERC20Tokens[ERC20Token] = minERC20Amount;

        emit ERC20TokenEnabled(ERC20Token, minERC20Amount);
    }

    /// @notice Disabled bridging support for the given ERC20 token.
    /// @param ERC20Token Address of the ERC20 token to be disabled.
    /// @dev Requirements:
    ///      - Access restricted with the `onlyOwner` modifier,
    ///      - The ERC20 token must be enabled.
    function disableERC20Token(address ERC20Token) external onlyOwner {
        // enableERC20Token does not allow ERC20Token to be 0x0 address so, it's
        // enough to check if the token is enabled, without checking if it's 0x0.
        if (ERC20Tokens[ERC20Token] == 0) {
            revert ERC20TokenNotEnabled();
        }

        ERC20TokensCount--;
        delete ERC20Tokens[ERC20Token];

        emit ERC20TokenDisabled(ERC20Token);
    }

    /// @notice Updates the minimum ERC20 amount allowed to be bridged using
    ///         `bridgeERC20`.
    /// @param newMinERC20Amount New minimum ERC20 amount (in the token precision).
    ///                          Must be positive.
    /// @dev Requirements:
    ///      - Access restricted with the `onlyOwner` modifier,
    ///      - The ERC20 token must be enabled,
    ///      - The new minimum ERC20 amount must be positive.
    function updateMinERC20Amount(
        address ERC20Token,
        uint256 newMinERC20Amount
    ) external onlyOwner {
        // enableERC20Token does not allow ERC20Token to be 0x0 address so, it's
        // enough to check if the token is enabled, without checking if it's 0x0.
        if (ERC20Tokens[ERC20Token] == 0) {
            revert ERC20TokenNotEnabled();
        }

        if (newMinERC20Amount == 0) {
            revert MinERC20AmountIsZero();
        }

        ERC20Tokens[ERC20Token] = newMinERC20Amount;

        emit MinERC20AmountUpdated(ERC20Token, newMinERC20Amount);
    }

    /// @notice Bridges the `amount` of the `ERC20Token` to the `recipient` address on Mezo.
    /// @param ERC20Token Address of the bridged ERC20 token.
    /// @param amount Amount of the bridged ERC20 token.
    /// @param recipient Recipient of the bridged ERC20 token on Mezo.
    /// @dev Requirements:
    ///      - The ERC20 token must be enabled,
    ///      - The recipient address must not be the zero address,
    ///      - The amount must be greater than or equal to the minimum ERC20 amount,
    ///      - The caller must have allowed the contract to transfer the `amount` of the `ERC20Token`.
    function bridgeERC20(
        address ERC20Token,
        uint256 amount,
        address recipient
    ) external nonReentrant {
        // enableERC20Token does not allow ERC20Token to be 0x0 address so, it's
        // enough to check if the token is enabled, without checking if it's 0x0.
        uint256 minERC20Amount = ERC20Tokens[ERC20Token];
        if (minERC20Amount == 0) {
            revert ERC20TokenNotEnabled();
        }

        if (recipient == address(0)) {
            revert ERC20RecipientIsZeroAddress();
        }

        if (amount < minERC20Amount) {
            revert AmountBelowMinERC20Amount();
        }

        _bridge(recipient, ERC20Token, amount);

        IERC20(ERC20Token).safeTransferFrom(msg.sender, address(this), amount);
    }
}
