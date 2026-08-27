// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Donations
/// @notice A contract for donating ERC20 tokens to a predefined beneficiary.
/// @dev The beneficiaries are identified by a string identifier, which is mapped
///      to the recipient address. The mapping is set by the owner of the contract.
///      The contract supports ERC20 tokens that support the ERC2612 permit
///      extension.
contract Donations is Ownable2StepUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice Emitted when the beneficiary is updated.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @param recipient The address of the recipient.
    event BeneficiaryUpdated(
        string indexed beneficiaryId,
        address indexed recipient
    );

    /// @notice Emitted when a donation is made.
    /// @param donor The address of the donor.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @param recipient The address of the recipient.
    /// @param amount The amount of tokens donated.
    event Donated(
        address indexed donor,
        string indexed beneficiaryId,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Emitted when the beneficiary is not supported.
    error UnsupportedBeneficiary();

    /// @notice Emitted when the payment token is the zero address.
    error PaymentTokenZeroAddress();

    /// @notice The address of the payment token.
    address public paymentToken;

    /// @notice A mapping of beneficiary IDs to recipient addresses.
    mapping(string => address) public beneficiaryIdToRecipient;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _paymentToken) public initializer {
        __Ownable2Step_init();
        __Ownable_init(msg.sender);

        if (_paymentToken == address(0)) {
            revert PaymentTokenZeroAddress();
        }

        paymentToken = _paymentToken;
    }

    /// @notice Updates the beneficiary for a given beneficiary ID.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @param recipient The address of the recipient.
    function updateBeneficiary(
        string calldata beneficiaryId,
        address recipient
    ) external onlyOwner {
        emit BeneficiaryUpdated(beneficiaryId, recipient);

        beneficiaryIdToRecipient[beneficiaryId] = recipient;
    }

    /// @notice Returns the recipient for a given beneficiary ID.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @return recipient The address of the recipient.
    function getBeneficiaryRecipient(
        string calldata beneficiaryId
    ) public view returns (address) {
        return beneficiaryIdToRecipient[beneficiaryId];
    }

    /// @notice Donates ERC20 tokens to a predefined beneficiary using a permit.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @param amount The amount of tokens to donate.
    /// @param deadline The deadline of the permit.
    /// @param v The v component of the signature.
    /// @param r The r component of the signature.
    /// @param s The s component of the signature.
    function donateWithPermit(
        string calldata beneficiaryId,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
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

        donate(beneficiaryId, amount);
    }

    /// @notice Donates ERC20 tokens to a predefined beneficiary.
    /// @param beneficiaryId The ID of the beneficiary.
    /// @param amount The amount of tokens to donate.
    function donate(string calldata beneficiaryId, uint256 amount) public {
        address recipient = beneficiaryIdToRecipient[beneficiaryId];

        if (recipient == address(0)) {
            revert UnsupportedBeneficiary();
        }

        emit Donated(msg.sender, beneficiaryId, recipient, amount);

        IERC20(paymentToken).safeTransferFrom(msg.sender, recipient, amount);
    }
}
