// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Store
/// @notice A contract for a store that sells products.
contract Store is Ownable2StepUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice A struct that represents an order.
    /// @dev The types were optimized to the smallest possible size to save
    ///      gas on storage. It is expected the struct will use one storage slot.
    struct Order {
        /// The ID of the order. Incremented by 1 for each new order.
        uint32 orderId;
        /// The ID of the product.
        uint32 productId;
        /// The price of the product.
        uint96 price;
    }

    /// @notice A struct that represents a product.
    /// @dev The types were optimized to the smallest possible size to save
    ///      gas on storage. It is expected the struct will use one storage slot.
    struct Product {
        /// The price of the product. If the price is 0, the product is not
        /// available for purchase.
        uint96 price;
        /// The stock of the product. For each order, the stock is decremented.
        /// If the stock is 0, the product is out of stock.
        /// The stock is not decremented if this value is set to the maximum
        /// value of `uint16` (65 535), which means that the stock is unlimited.
        uint16 stock;
        /// The maximum number of orders of the product per each customer.
        /// If the value is 0, the limit is disabled, and each customer can order
        /// as many products as they want.
        uint8 perCustomerLimit;
    }

    /// @notice The address of the store treasury. This is the address that will
    ///         receive the payment token when a customer orders a product.
    address public storeTreasury;

    /// @notice The address of the store manager. This is the address that will
    ///         be able to update product details.
    address public storeManager;

    /// @notice The address of the payment token.
    address public paymentToken;

    /// @notice The next order ID.
    uint32 public nextOrderId;

    /// @notice A mapping of customer addresses to their orders of each product.
    mapping(address => mapping(uint32 => Order[])) public orders;

    /// @notice A mapping of product IDs to product details.
    mapping(uint32 => Product) public products;

    /// @notice Emitted when the store treasury is updated.
    event StoreTreasuryUpdated(address newStoreTreasury);

    /// @notice Emitted when the store manager is updated.
    event StoreManagerUpdated(address newStoreManager);

    /// @notice Emitted when the price of a product is updated.
    event ProductPriceUpdated(uint32 indexed productId, uint96 newPrice);

    /// @notice Emitted when the stock of a product is updated.
    event ProductStockUpdated(uint32 indexed productId, uint16 newStock);

    /// @notice Emitted when the per customer limit of a product is updated.
    event ProductPerCustomerLimitUpdated(
        uint32 indexed productId,
        uint8 newPerCustomerLimit
    );

    /// @notice Emitted when an order is placed.
    event OrderPlaced(
        uint32 indexed orderId,
        address indexed customer,
        uint32 indexed productId,
        uint96 price
    );

    error CallerNotStoreManagerOrOwner();

    error PaymentTokenZeroAddress();
    error StoreTreasuryZeroAddress();
    error StoreManagerZeroAddress();
    error UnknownProduct();
    error ProductOutOfStock();
    error ProductPerCustomerLimitReached();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyStoreManagerOrOwner() {
        if (msg.sender != storeManager && msg.sender != owner()) {
            revert CallerNotStoreManagerOrOwner();
        }
        _;
    }

    function initialize(address _paymentToken) public initializer {
        __Ownable2Step_init();
        __Ownable_init(msg.sender);

        if (_paymentToken == address(0)) {
            revert PaymentTokenZeroAddress();
        }

        emit StoreManagerUpdated(msg.sender);

        paymentToken = _paymentToken;
        storeManager = msg.sender;
        nextOrderId = 1;
    }

    /// @notice Updates the store treasury.
    /// @dev Only the owner can call this function.
    /// @param newStoreTreasury The new store treasury address.
    function updateStoreTreasury(address newStoreTreasury) external onlyOwner {
        if (newStoreTreasury == address(0)) {
            revert StoreTreasuryZeroAddress();
        }

        emit StoreTreasuryUpdated(newStoreTreasury);

        storeTreasury = newStoreTreasury;
    }

    /// @notice Updates the store manager.
    /// @dev Only the owner can call this function.
    /// @param newStoreManager The new store manager address.
    function updateStoreManager(address newStoreManager) external onlyOwner {
        if (newStoreManager == address(0)) {
            revert StoreManagerZeroAddress();
        }

        emit StoreManagerUpdated(newStoreManager);

        storeManager = newStoreManager;
    }

    /// @notice Updates the price of a product.
    /// @dev Only the owner can call this function.
    /// @param productId The ID of the product.
    /// @param price The new price of the product.
    function updateProductPrice(
        uint32 productId,
        uint96 price
    ) external onlyStoreManagerOrOwner {
        emit ProductPriceUpdated(productId, price);

        products[productId].price = price;
    }

    /// @notice Updates the stock of a product.
    /// @dev Only the owner can call this function.
    /// @param productId The ID of the product.
    /// @param stock The new stock of the product.
    function updateProductStock(
        uint32 productId,
        uint16 stock
    ) external onlyStoreManagerOrOwner {
        emit ProductStockUpdated(productId, stock);

        products[productId].stock = stock;
    }

    /// @notice Updates the per customer limit of a product.
    /// @dev Only the owner can call this function.
    /// @param productId The ID of the product.
    /// @param perCustomerLimit The new per customer limit of the product.
    function updateProductPerCustomerLimit(
        uint32 productId,
        uint8 perCustomerLimit
    ) external onlyStoreManagerOrOwner {
        emit ProductPerCustomerLimitUpdated(productId, perCustomerLimit);

        products[productId].perCustomerLimit = perCustomerLimit;
    }

    /// @notice Returns the details of a product.
    /// @param productId The ID of the product.
    /// @return product The details of the product.
    function getProductDetails(
        uint32 productId
    ) external view returns (Product memory) {
        return products[productId];
    }

    /// @notice Returns all orders for a user.
    /// @param user The address of the user.
    /// @return orders The orders for the user.
    function getOrders(
        address user,
        uint32 productId
    ) external view returns (Order[] memory) {
        return orders[user][productId];
    }

    /// @notice Orders a product with a permit.
    /// @dev The permit is expected to be signed for the amount matching the
    ///      product price.
    /// @param productId The ID of the product.
    /// @param deadline The deadline of the permit.
    /// @param v The v component of the signature.
    /// @param r The r component of the signature.
    /// @param s The s component of the signature.
    function orderWithPermit(
        uint32 productId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        uint96 amount = products[productId].price;

        // Permit has a built-in replay protection, which means it can be frontrun
        // and submitted by anyone.
        // We try to call the permit function, and if it reverts, we ignore the
        // error, as it might be already submitted.
        try
            IERC20Permit(paymentToken).permit(
                msg.sender,
                address(this),
                amount,
                deadline,
                v,
                r,
                s
            )
        {} catch {}

        order(productId);
    }

    /// @notice Orders a product.
    /// @dev The caller must have approved the payment token for the amount
    ///      matching the product price.
    ///      If the product price is 0, the product is not available for
    ///      purchase.
    ///      If the product stock is 0, the product is out of stock.
    ///      If the stock is set to the maximum value of `uint32`, the stock
    ///      is unlimited.
    ///      If the product per customer limit is reached, the caller cannot
    ///      order the product.
    /// @param productId The ID of the product.
    function order(uint32 productId) public {
        if (storeTreasury == address(0)) {
            revert StoreTreasuryZeroAddress();
        }

        uint96 price = products[productId].price;
        uint32 stock = products[productId].stock;
        uint8 perCustomerLimit = products[productId].perCustomerLimit;

        if (price == 0) {
            revert UnknownProduct();
        }

        if (stock == 0) {
            revert ProductOutOfStock();
        }

        if (
            perCustomerLimit > 0 &&
            orders[msg.sender][productId].length >= perCustomerLimit
        ) {
            revert ProductPerCustomerLimitReached();
        }

        if (stock < type(uint16).max) products[productId].stock--;

        uint32 orderId = nextOrderId++;

        orders[msg.sender][productId].push(
            Order({orderId: orderId, productId: productId, price: price})
        );

        emit OrderPlaced(orderId, msg.sender, productId, price);

        IERC20(paymentToken).safeTransferFrom(msg.sender, storeTreasury, price);
    }
}
