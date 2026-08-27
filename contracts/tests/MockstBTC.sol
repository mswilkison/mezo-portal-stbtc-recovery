// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import {IReceiptToken} from "./../interfaces/IReceiptToken.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice MockSTBC is a mock implementation of Acre's stBTC and mimics the
///         behaviour of their token.
contract MockSTBTC is ERC20, IReceiptToken, Ownable {
    error InsufficientDebtAllowance();
    error ExcessiveDebtRepayment();

    mapping(address => uint256) public allowedDebt;
    mapping(address => uint256) public currentDebt;

    constructor() ERC20("stBTC", "stBTC") Ownable(msg.sender) {}

    function updateDebtAllowance(
        address debtor,
        uint256 newAllowance
    ) external onlyOwner {
        allowedDebt[debtor] = newAllowance;
    }

    function mintReceipt(address to, uint256 amount) external {
        currentDebt[msg.sender] += amount;

        if (currentDebt[msg.sender] > allowedDebt[msg.sender]) {
            revert InsufficientDebtAllowance();
        }

        super._mint(to, amount);
    }

    function burnReceipt(uint256 amount) external {
        if (currentDebt[msg.sender] < amount) {
            revert ExcessiveDebtRepayment();
        }

        currentDebt[msg.sender] -= amount;
        super._burn(msg.sender, amount);
    }
}
