// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

interface ITroveManager {
    function getTroveDebt(address _borrower) external view returns (uint);
}
