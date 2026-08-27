// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import {BitcoinBridge} from "./BitcoinBridge.sol";
import {ERC20Bridge} from "./ERC20Bridge.sol";

/// @notice MezoBridge contract allows bridging Bitcoin (using tBTC) and other
///         ERC20 tokens from Ethereum to the Mezo chain.
/// @dev The contract inherits specific bridging capabilities from BitcoinBridge
///      and ERC20Bridge abstract contracts.
/// @dev The contract is supposed to be deployed behind a transparent
///      upgradeable proxy.
contract MezoBridge is BitcoinBridge, ERC20Bridge {
    /// @notice Holds the count of all bridging requests made so far. Includes
    ///         both Bitcoin and ERC20 bridging requests. It is incremented every
    ///         time a new bridging request is made. Its value is used to assign
    ///         sequence numbers to these requests which help to keep track of them.
    uint256 public sequence;

    event AssetsLocked(
        uint256 indexed sequenceNumber,
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract.
    /// @dev All addresses passed to the contract must not be 0x0.
    /// @param _tbtcBridge Address to the tBTC Bridge contract.
    /// @param _tbtcVault Address to the tBTC TBTCVault contract.
    /// @param _tbtcToken Address to the tBTC ERC20 token contract.
    /// @param _initialSequence Initial sequence number. Normally, it should be zero.
    ///        A non-zero value can be set when migrating from an old bridge contract,
    ///        to keep continuity in the sequence numbers on Mezo.
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _tbtcToken,
        uint256 _initialSequence
    ) external initializer {
        __BitcoinBridge_initialize(_tbtcBridge, _tbtcVault, _tbtcToken);
        __ERC20Bridge_initialize();

        //slither-disable-next-line events-maths
        sequence = _initialSequence;
    }

    /// @notice Bridges the `amount` of the `token` to the `recipient` address on Mezo.
    /// @param recipient Recipient of the bridged token.
    /// @param token Address of the bridged token.
    /// @param amount Amount of the bridged token.
    /// @dev Increases the sequence number and emits the AssetsLocked event.
    ///      The AssetsLocked event is a sign for Mezo validators to process
    ///      the bridging request.
    function _bridge(
        address recipient,
        address token,
        uint256 amount
    ) internal override(BitcoinBridge, ERC20Bridge) {
        emit AssetsLocked(++sequence, recipient, token, amount);
    }
}
