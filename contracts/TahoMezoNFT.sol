// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/ITroveManager.sol";

interface TahoMezoNFTErrors {
    /**
     * This install id has already been used for claiming
     */
    error AlreadyClaimed(string installId);

    /**
     * This address already holds a claimed NFT
     */
    error MaxTokensPerAddress(address recipient);

    /**
     * This address does not have an active borrow
     */
    error MissingBorrowRequirement(address recipient);

    /**
     * Invalid claim signature
     */
    error InvalidSignature(address recoveredSigner);

    error InvalidAddress();
}

contract TahoMezoNFT is
    OwnableUpgradeable,
    ERC1155Upgradeable,
    TahoMezoNFTErrors
{
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;
    using Strings for string;

    event Mint(address claimerAddress, string installId);

    address public token;
    address public troveManager;
    address public verifier;

    uint256 public constant NFT_ID = 1;
    uint256 public constant TOKEN_AMOUNT = 100 * 10 ** 18;

    // Wallet install ids (uuidv4) that have been used to claim the NFT
    mapping(string => bool) public claimedIds;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory uri,
        address _token,
        address _troveManager
    ) public initializer {
        __Ownable_init(msg.sender);
        __ERC1155_init(uri);

        if (_token == address(0) || _troveManager == address(0))
            revert InvalidAddress();
        token = _token;
        troveManager = _troveManager;
        verifier = msg.sender;
    }

    function setVerifier(address newVerifier) external onlyOwner {
        if (newVerifier == address(0)) revert InvalidAddress();
        verifier = newVerifier;
    }

    function setURI(string calldata newUri) external onlyOwner {
        _setURI(newUri);
        emit URI(newUri, NFT_ID);
    }

    function transferTokens() external onlyOwner {
        IERC20 _token = IERC20(token);
        _token.safeTransfer(owner(), _token.balanceOf(address(this)));
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 id,
        uint256 value,
        bytes memory data
    ) public virtual override(ERC1155Upgradeable) {
        if (balanceOf(to, NFT_ID) == 1) {
            revert MaxTokensPerAddress(to);
        }

        return super.safeTransferFrom(from, to, id, value, data);
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values,
        bytes memory data
    ) public virtual override(ERC1155Upgradeable) {
        if (balanceOf(to, NFT_ID) == 1) {
            revert MaxTokensPerAddress(to);
        }

        return super.safeBatchTransferFrom(from, to, ids, values, data);
    }

    function mint(
        string calldata installId,
        bytes calldata signature
    ) external {
        if (claimedIds[installId]) {
            revert AlreadyClaimed(installId);
        }

        bytes32 signedMsgHash = MessageHashUtils.toEthSignedMessageHash(
            (abi.encodePacked(installId, msg.sender))
        );

        address signer = signedMsgHash.recover(signature);

        if (signer != verifier) {
            revert InvalidSignature(signer);
        }

        if (balanceOf(msg.sender, NFT_ID) > 0) {
            revert MaxTokensPerAddress(msg.sender);
        }

        if (ITroveManager(troveManager).getTroveDebt(msg.sender) == 0) {
            revert MissingBorrowRequirement(msg.sender);
        }

        claimedIds[installId] = true; // Mark install id as used

        IERC20(token).safeTransferFrom(msg.sender, address(this), TOKEN_AMOUNT);

        _mint(msg.sender, NFT_ID, 1, "");
        emit Mint(msg.sender, installId);
    }
}
