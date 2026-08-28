// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import {IReceiptToken} from "./../interfaces/IReceiptToken.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IPortalStbtcRecoveryReentry {
    struct ReceiptDebtSettlement {
        address depositor;
        uint256 depositId;
        uint96 amount;
    }

    struct DepositorContext {
        address depositor;
        uint256[] activeDepositIds;
    }

    function recoverTbtc(
        ReceiptDebtSettlement[] calldata settlements,
        DepositorContext[] calldata depositorContexts
    ) external returns (uint256);
}

/// @notice Malicious receipt token that reenters `recoverTbtc` from inside
///         `transferFrom`, used to prove the recovery implementation's
///         reentrancy guard actually engages through the proxy.
contract MockReentrantSTBTC is ERC20, IReceiptToken {
    bool public attackEnabled;

    constructor() ERC20("Reentrant stBTC", "rstBTC") {}

    function setAttack(bool enabled) external {
        attackEnabled = enabled;
    }

    function mintReceipt(address to, uint256 amount) external {
        super._mint(to, amount);
    }

    function burnReceipt(uint256 amount) external {
        super._burn(msg.sender, amount);
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (attackEnabled) {
            attackEnabled = false;
            // msg.sender is the Portal proxy running the recovery
            // implementation; the nested call must hit the guard.
            IPortalStbtcRecoveryReentry(msg.sender).recoverTbtc(
                new IPortalStbtcRecoveryReentry.ReceiptDebtSettlement[](0),
                new IPortalStbtcRecoveryReentry.DepositorContext[](0)
            );
        }

        return super.transferFrom(from, to, amount);
    }
}
