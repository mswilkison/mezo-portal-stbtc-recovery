// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MatsnetStore is OwnableUpgradeable {
    using SafeERC20 for IERC20;

    event OrderPlaced(
        address indexed customer,
        uint256 indexed orderId,
        string indexed productId,
        uint256 price
    );

    event ProductPriceUpdated(string indexed productId, uint256 price);

    error UnknownProduct();

    error IncorrectPaymentToken();

    struct Order {
        uint256 orderId;
        string productId;
        uint price;
    }

    mapping(address => Order[]) public orders;

    mapping(string => uint256) public productPrice;

    address public paymentToken;

    uint256 public nextOrderId;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _paymentToken) public initializer {
        __Ownable_init(msg.sender);

        if (_paymentToken == address(0)) {
            revert IncorrectPaymentToken();
        }

        paymentToken = _paymentToken;
        nextOrderId = 1;
    }

    function orderProduct(string memory productId) external {
        uint256 price = productPrice[productId];

        if (price == 0) {
            revert UnknownProduct();
        }

        orders[msg.sender].push(
            Order({orderId: nextOrderId, productId: productId, price: price})
        );

        emit OrderPlaced(msg.sender, nextOrderId, productId, price);

        nextOrderId++;
        IERC20(paymentToken).safeTransferFrom(msg.sender, address(this), price);
    }

    function setProductPrice(
        string memory productId,
        uint256 price
    ) external onlyOwner {
        emit ProductPriceUpdated(productId, price);
        productPrice[productId] = price;
    }

    function getAllOrders(address user) external view returns (Order[] memory) {
        return orders[user];
    }
}
