// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

/// @notice An interface to be optionally implemented by ERC20 tokens to retrieve
///         the decimals places of the token. We need this interface because to
///         properly calculate amounts when 2 tokens are involved we need to know
///         their decimals places.
///         As decimals() is optional in the ERC20 standard, additional interface
///         is needed to retrieve the decimals places of the token.
///         Portal contract assumes that only tokens supporting this interface
///         are accepted as supported tokens or receipt tokens.
interface IERC20WithDecimals {
    /// @notice Returns the decimals places of the token
    function decimals() external view returns (uint8);
}
