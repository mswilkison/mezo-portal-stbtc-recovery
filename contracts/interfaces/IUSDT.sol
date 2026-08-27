// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

/// @dev USDT token ignores ERC20 spec and returns no bool from the approve
///      function.
// slither-disable-start erc20-interface
interface IUSDT {
    function approve(address spender, uint256 value) external;
}
// slither-disable-end erc20-interface
