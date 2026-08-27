// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

/// @notice IReceiptToken is an interface that should be implemented by ERC20
///         receipt tokens used in the Portal contract.
interface IReceiptToken {
    /// @notice Mints `amount` receipt tokens and transfers them to the `to`
    ///         address.
    function mintReceipt(address to, uint256 amount) external;

    /// @notice Burns `amount` of receipt tokens owned by `msg.sender`.
    function burnReceipt(uint256 amount) external;
}
