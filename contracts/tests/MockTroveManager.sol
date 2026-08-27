// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "../interfaces/ITroveManager.sol";

contract MockTroveManager is ITroveManager {
    mapping(address => uint) public debts;

    function getTroveDebt(address borrower) external view returns (uint) {
        return debts[borrower];
    }

    function setDebt(address borrower, uint debt) external {
        debts[borrower] = debt;
    }
}
