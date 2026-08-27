// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IReceiveApproval.sol";
import "./interfaces/IReceiptToken.sol";
import "./interfaces/IERC20WithPermit.sol";
import "./interfaces/IERC20WithDecimals.sol";
import "./interfaces/IUSDT.sol";
import "./MezoBridge.sol";

contract Portal is Ownable2StepUpgradeable, IReceiveApproval {
    using SafeERC20 for IERC20;

    /// @notice Supported token ability defines what can be done with
    ///         a given token. Some tokens can be deposited but can not be locked.
    enum TokenAbility {
        None,
        Deposit,
        DepositAndLock
    }

    /// @notice Represents the to-tBTC migration state of a deposit. Note that
    ///         to-tBTC migration is only available for selected assets, as set
    ///         by the governance.
    enum TbtcMigrationState {
        NotRequested,
        Requested,
        InProgress,
        Completed
    }

    /// @notice Supported token struct to pair a token address with its ability
    /// @dev This is an auxiliary struct used to initialize the contract with
    ///      the supported tokens and for governance to add new supported tokens.
    ///      This struct is not used in the storage.
    struct SupportedToken {
        address token;
        TokenAbility tokenAbility;
    }

    /// @notice Groups depositor address to their deposit ID to pass in an array
    ///         to trigger and complete the to-tBTC migration by the tBTC
    ///         migration treasury.
    /// @dev This is an auxiliary struct used as a parameter in to-tBTC
    ///      migration functions. This struct is not used in the storage.
    struct DepositToMigrate {
        address depositor;
        uint256 depositId;
    }

    /// @notice Groups depositor address to their deposit ID to pass in an array
    ///         to perform auto-bridging of deposits to the Mezo chain.
    /// @dev This is an auxiliary struct used as a parameter in
    ///      `autoBridgeDeposits`.
    struct DepositToAutoBridge {
        address depositor;
        uint256 depositId;
    }

    /// @notice DepositInfo keeps track of the deposit balance and unlock time.
    ///         Each deposit is tracked separately and associated with a specific
    ///         token. Some tokens can be deposited but can not be locked - in
    ///         that case the unlockAt is the block timestamp of when the deposit
    ///         was created. The same is true for tokens that can be locked but
    ///         the depositor decided not to lock them. Some deposits can mint
    ///         a receipt tokens against them: receiptMinted is the amount of
    ///         receipt tokens minted against a deposit, while feeOwed is the
    ///         fee owed by the deposit to Portal, and the lastFeeIntegral is
    ///         the last updated value of the fee integral.
    struct DepositInfo {
        uint96 balance;
        uint32 unlockAt;
        // The amount of the receipt token minted for the deposit. Zero if no
        // receipt token was minted.
        uint96 receiptMinted;
        // The fee owed if the receipt token was minted and the fee is non-zero.
        // Fee owed is calculated based on the receipt tokens minted and is stored
        // using receipt token decimals. The fee is collected when the deposit is
        // withdrawn, adjusted to the deposit token decimals.
        uint96 feeOwed;
        // The last value of the receipt token fee integral. Zero if no receipt
        // token was minted, if the fee is zero, or if the integral was not yet
        // calculated.
        uint88 lastFeeIntegral;
        // The state of tBTC migration. If the to-tBTC migration is not allowed
        // for the asset or if it was not requested by the depositor, the state
        // is NotRequested.
        TbtcMigrationState tbtcMigrationState;
        // Indication whether the deposit should opt-out from auto-bridging to
        // the Mezo chain. If set to true, it will not be possible to auto-
        // bridge the deposit.
        bool autoBridgingOptOut;
    }

    /// @notice Keeps information about to-tBTC migration status for the asset:
    ///         whether the migration is allowed and what is the total amount
    ///         of the asset being currently in-progress for the migration.
    struct TbtcMigrationInfo {
        // Indicates whether the migration to tBTC was enabled by the governance
        // for the asset.
        bool isAllowed;
        // The total amount that is currently migrated to tBTC. The value uses
        // the same number of decimals as the asset being migrated.
        uint96 totalMigrating;
    }

    /// @notice FeeInfo keeps track of the receipt token minting situation per
    ///         the supported deposit token.
    ///
    ///         The current fee rate for minting against deposits is
    ///         calculated separately for each token, and tracked as integral.
    ///
    ///         The fee rate has a single component: a governable base annual
    ///         fee, capped at 100%.
    ///
    ///         The annual fee is converted to a non-compounding fee per second,
    ///         R. This rate is then multiplied by time in seconds to get the
    ///         accumulated fee integral. The difference between the integral
    ///         in time T_1 and T_2 tracks how much fee is accrued per minted
    ///         token unit during that time. The minted amount A is multiplied
    ///         by R, and divided by a scalar constant to get the amount of fee
    ///         in the same units as A.
    struct FeeInfo {
        // XXX: not tracking total deposited - use token balance
        // someone could send token to the contract outside locked deposits

        // The amount of receipt tokens minted across all deposits for the given
        // deposit token.
        uint96 totalMinted;
        // The timestamp of the block of the last fee update.
        uint32 lastFeeUpdateAt;
        // The integral tracks how much fee is accrued over time.
        uint88 feeIntegral;
        // Fee per annum in percentage.
        uint8 annualFee;
        // Receipt token minting cap in percentage, per deposit.
        uint8 mintCap;
        // A token supporting the IReceiptToken interface and used as a receipt
        // token. Zero address if the given deposit token does not allow minting
        // receipt tokens.
        address receiptToken;
        // Counts fees collected across all withdrawn deposits for the given
        // deposit token. Fees are collected based on the receipt tokens earlier
        // minted and the annual fee.
        uint96 feeCollected;
    }

    /// @notice Mapping of the details of all the deposited funds:
    ///         depositor address -> token address -> deposit id -> DepositInfo
    mapping(address => mapping(address => mapping(uint256 => DepositInfo)))
        public deposits;

    /// @notice The number of deposits created. Includes the deposits that
    ///         were fully withdrawn. This is also the identifier of the most
    ///         recently created deposit.
    uint256 public depositCount;

    /// @notice List of tokens enabled for deposit or for deposit and lock.
    mapping(address => TokenAbility) public tokenAbility;

    /// @notice Minimum time a deposit can be locked.
    uint32 public minLockPeriod;

    /// @notice Maximum time a deposit can be locked.
    uint32 public maxLockPeriod;

    /// @notice Address of the liquidity treasury multisig.
    address public liquidityTreasury;

    /// @notice Mapping to store whether an asset is managed by the liquidity
    ///         treasury multisig.
    mapping(address => bool) public liquidityTreasuryManaged;

    /// @notice Mapping of depositable tokens to their receipt token fee
    ///         parameters.
    mapping(address => FeeInfo) public feeInfo;

    /// @notice Address of the tBTC token. Used for the to-tBTC migration of
    ///         deposited assets for which the migration was enabled by the
    ///         governance.
    address public tbtcToken;

    /// @notice Address of the tBTC migration treasury multisig. The tBTC
    ///         migration treasury is responsible for conducting the
    ///         to-tBTC migration of deposited assets for which the migration
    ///         was enabled by the governance.
    address public tbtcMigrationTreasury;

    /// @notice Mapping indicating whether the given asset can be migrated to
    ///         tBTC by the tBTC migration treasury and if so, what is the
    ///         global status of migrations. The key to the mapping is the
    ///         address of the asset being migrated.
    mapping(address => TbtcMigrationInfo) public tbtcMigrations;

    /// @notice Mezo bridge that can be used to bridge tBTC or other ERC20
    ///         tokens to the Mezo chain. Assets to be bridged must meet
    ///         criteria specified in the Mezo bridge: the token must be enabled
    ///         and the amount must be above the minimum value.
    MezoBridge public mezoBridge;

    /// @notice Address of the auto-bridge coordinator. This address is allowed
    ///         to perform auto-bridging of deposits to the Mezo chain.
    address public autoBridgeCoordinator;

    /// @notice Deposit global unlock timestamp beyond which all deposits are
    ///         withdrawable.
    uint32 public depositGlobalUnlockAt;

    /// @notice Address of the WBTC token. This address is checked during
    ///         auto-bridging to Mezo to prevent WBTC token deposits from being
    ///         auto-bridged.
    address public wbtcToken;

    //
    // The ReentrancyGuard fields copied from OpenZeppelin. We copy the code
    // instead of extending the contract to avoid problems with storage slot
    // conflicts.
    //

    // In the original `ReentrancyGuard` code from OpenZeppelin the values `1`
    // and `2` were used. Here we opted for `0` and `1` as this guarantees
    // the `_status` variable will be initialized as `NOT_ENTERED` by default.
    uint256 private constant NOT_ENTERED = 0;
    uint256 private constant ENTERED = 1;

    uint256 private _status;
    //
    // EOF ReentrancyGuard
    //

    /// @dev USDT token address. USDT does not respect approve interface of
    ///      ERC20 and requires special handling.
    address internal constant USDT_ADDRESS =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;

    event Deposited(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    event Withdrawn(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    event Locked(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint32 unlockAt,
        uint32 lockPeriod
    );

    event SupportedTokenAdded(address indexed token, TokenAbility tokenAbility);

    event MaxLockPeriodUpdated(uint32 maxLockPeriod);

    event MinLockPeriodUpdated(uint32 minLockPeriod);

    /// @notice Event emitted when the liquidity treasury address is updated.
    event LiquidityTreasuryUpdated(
        address indexed previousLiquidityTreasury,
        address indexed newLiquidityTreasury
    );

    /// @notice Event emitted when an asset is withdrawn by the liquidity
    ///         treasury multisig.
    event WithdrawnByLiquidityTreasury(address indexed token, uint256 amount);

    /// @notice Event emitted when an asset is set/unset as a liquidity
    ///         treasury multisig managed asset.
    event LiquidityTreasuryManagedAssetUpdated(
        address indexed asset,
        bool isManaged
    );

    /// @notice Event emitted when the receipt parameters for a deposit token
    ///         are updated.
    event ReceiptParamsUpdated(
        address indexed token,
        uint8 annualFee,
        uint8 mintCap,
        address receiptToken
    );

    /// @notice Event emitted when a receipt token is minted for a deposit.
    event ReceiptMinted(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    /// @notice Event emitted when a receipt token is repaid for a deposit.
    event ReceiptRepaid(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    /// @notice Event emitted when a fee is collected for a deposit.
    event FeeCollected(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 fee
    );

    /// @notice Event emitted when the tBTC token address used for the
    ///         to-tBTC migration was set by the governance.
    /// @dev This event can be emitted only one time.
    event TbtcTokenAddressSet(address tbtc);

    /// @notice Event emitted when the to-tBTC migration treasury address was
    ///         updated.
    event TbtcMigrationTreasuryUpdated(
        address indexed previousMigrationTreasury,
        address indexed newMigrationTreasury
    );

    /// @notice Event emitted when the eligibility for the to-tBTC migration
    ///         for the asset was updated.
    event TbtcMigrationAllowedUpdated(address indexed token, bool isAllowed);

    /// @notice Event emitted when the to-tBTC migration was requested for the
    ///         deposit.
    event TbtcMigrationRequested(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when the to-tBTC migration was started for the
    ///         deposit.
    event TbtcMigrationStarted(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when the tBTC migration treasury started to-tBTC
    ///         migration for a set of deposits withdrawing the given amount of
    ///         the token from the Portal contract.
    event WithdrawnForTbtcMigration(address indexed token, uint256 amount);

    /// @notice Event emitted when the to-tBTC migration was completed for the
    ///         deposit.
    event TbtcMigrationCompleted(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when the to-tBTC migration was completed for one
    ///         or multiple deposits and the Portal contract was funded with
    ///         tBTC coming from the migrated assets.
    /// @dev The `amount` in the event is the amount in tBTC, using tBTC token's
    ///      precision.
    event FundedFromTbtcMigration(uint256 amount);

    /// @notice Event emitted in similar circumstances as `Withdrawn` except
    ///         that it represents a to-tBTC migrated deposit where the
    ///         withdrawal is performed in tBTC and not in the original deposit
    ///         token.
    event WithdrawnTbtcMigrated(
        address indexed depositor,
        address indexed token,
        address tbtcToken,
        uint256 indexed depositId,
        uint256 amountInTbtc
    );

    /// @notice Event emitted in similar circumstances as `FeeCollected`
    ///         except that it represents a to-tBTC migrated deposit where the
    ///         fee is collected in tBTC and not in the original deposit token.
    event FeeCollectedTbtcMigrated(
        address indexed depositor,
        address indexed token,
        address tbtcToken,
        uint256 indexed depositId,
        uint256 feeInTbtc
    );

    /// @notice Event emitted when the address of the Mezo bridge is updated.
    event MezoBridgeUpdated(
        address indexed previousMezoBridge,
        address indexed newMezoBridge
    );

    /// @notice Event emitted when the address of the auto-bridge coordinator is
    ///         updated.
    event AutoBridgeCoordinatorUpdated(
        address indexed previousAutoBridgeCoordinator,
        address indexed newAutoBridgeCoordinator
    );

    /// @notice Event emitted when the deposit global unlock at timestamp is
    ///         updated.
    event DepositGlobalUnlockAtUpdated(
        uint32 previousDepositGlobalUnlockAt,
        uint32 newDepositGlobalUnlockAt
    );

    /// @notice Event emitted when a deposit auto-bridging opt-out is set.
    event DepositAutoBridgingOptOutSet(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        bool optOut
    );

    /// @notice Event emitted when a deposit opting-out from auto-bridging is
    ///         skipped.
    event OptOutDepositAutoBridgingSkipped(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when a withdrawn deposit is skipped during
    ///         auto-bridging. This happens when the user withdrew the
    ///         deposit or if the deposit was already bridged.
    event WithdrawnDepositAutoBridgingSkipped(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when a deposit for which stBTC was minted and not
    ///         repaid is skipped during auto-bridging.
    event ReceiptMintedDepositAutoBridgingSkipped(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when a deposit for which to-tBTC migration
    ///         was requested is skipped during auto-bridging.
    event TbtcMigratingDepositAutoBridgingSkipped(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId
    );

    /// @notice Event emitted when a deposit is auto-bridged.
    event DepositAutoBridged(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    event DepositBridged(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    /// @notice Event emitted when the WBTC token address used for performing
    ///         checks during auto-bridging of deposits to Mezo was set.
    event WbtcTokenAddressSet(address wbtcToken);

    error IncorrectTokenAddress(address token);

    error IncorrectTokenAbility(TokenAbility ability);

    error IncorrectDepositor(address depositor);

    error IncorrectAmount(uint256 amount);

    error TokenNotSupported(address token);

    error TokenAlreadySupported(address token, TokenAbility tokenAbility);

    error InsufficientTokenAbility(address token, TokenAbility tokenAbility);

    error LockPeriodOutOfRange(uint32 lockPeriod);

    error IncorrectLockPeriod(uint256 lockPeriod);

    error LockPeriodTooShort(
        uint32 lockPeriod,
        uint32 newUnlockAt,
        uint32 existingUnlockAt
    );

    error DepositLocked(uint32 unlockAt);

    error DepositNotFound();

    /// @notice Error when the partial withdrawal amount is too high. Either it
    ///         equals the deposit amount (not a partial withdrawal) or it is
    ///         higher than the deposit amount.
    error PartialWithdrawalAmountTooHigh(uint256 depositAmount);

    /// @notice Error when the sender is not the liquidity treasury.
    error SenderNotLiquidityTreasury(address sender);

    /// @notice Error when the asset is not managed by the liquidity treasury.
    error AssetNotManagedByLiquidityTreasury(address asset);

    /// @notice Error when trying to withdraw without repaying the minted
    ///         receipt tokens back to Portal.
    error ReceiptNotRepaid(uint256 receiptMinted);

    /// @notice Error when the user tries to partially withdraw but the fee for
    ///         minting the receipt token is non-zero. In this case only a full
    ///         deposit withdrawal is possible.
    error ReceiptFeeOwed(uint256 feeOwed);

    /// @notice Error when the user tries to mint more than the mint limit
    ///         allows.
    error ReceiptMintLimitExceeded(
        uint256 mintLimit,
        uint96 currentlyMinted,
        uint256 feeOwed,
        uint256 amount
    );

    /// @notice Error when the user tries to repay more than the minted debt.
    error RepayAmountExceededDebt(uint96 mintedDebt, uint256 amount);

    /// @notice Error when the annual fee proposed exceeds 100%.
    error MaxAnnualFeeExceeded(uint8 annualFee);

    /// @notice Error when the mint cap proposed exceeds 100%.
    error MaxReceiptMintCapExceeded(uint8 mintCap);

    /// @notice Error when there is no receipt token set for the asset.
    error ReceiptMintingDisabled();

    /// @notice Error when the receipt token is already initialized.
    error ReceiptTokenAlreadyInitialized();

    /// @notice Error when the receipt token decimals are not 18.
    error IncorrectReceiptTokenDecimals(address receiptToken);

    /// @notice Error when token being accepted as deposit token does not
    ///         support decimals() function or the function is malfunctioning.
    error UnknownTokenDecimals(address token);

    /// @notice The given asset can be marked as eligible for tBTC migration if
    ///         it is not managed by the liquidity treasury. The given asset
    ///         can be managed by the liquidity treasury if it is not marked as
    ///         eligible for tBTC migration. The transaction reverts with this
    ///         error when the governance changes would conflict with this
    ///         limitation.
    error TbtcMigrationAndLiquidityManagementConflict();

    /// @notice Error when the governance tries to add tBTC as an asset eligible
    ///         for to-tBTC migration.
    error TbtcCanNotBeMigrated();

    /// @notice Error when the tBTC token address used for to-tBTC migrations
    ///         was already set by the governance.
    error TbtcTokenAddressAlreadySet();

    /// @notice Error when the tBTC token address used for to-tBTC migrations
    ///         was not set by the governance but there is an attempt to enable
    ///         to-tBTC migration for some asset.
    error TbtcTokenAddressNotSet();

    /// @notice Error when someone else but the tBTC migration treasury tried
    ///         to withdraw tokens for tBTC migration or to complete the
    ///         migration process.
    error SenderNotTbtcMigrationTreasury();

    /// @notice Error when the given to-tBTC transition state change is
    ///         requested from an unexpected state. For example, it is not
    ///         allowed to complete the migration of a deposit for which the
    ///         migration was not requested.
    error UnexpectedTbtcMigrationState(
        uint256 depositId,
        TbtcMigrationState currentState,
        TbtcMigrationState expectedState
    );

    /// @notice Error when the to-tBTC migration for the asset was not allowed
    ///         by the governance but the depositor tried to request a migration.
    error TbtcMigrationNotAllowed();

    /// @notice Error when the to-tBTC migration has been requested but not yet
    ///         completed and the depositor tries to withdraw the deposit.
    error TbtcMigrationNotCompleted();

    /// @notice Error when the to-tBTC migration was requested and the depositor
    ///         tries to partially withdraw the deposit.
    /// @dev The `Err` suffix is to distinguish this error from the
    ///      `TbtcMigrationRequested` event.
    error TbtcMigrationRequestedErr();

    /// @notice Error when incorrect Mezo bridge address is provided.
    error IncorrectMezoBridgeAddress(address mezoBridge);

    /// @notice Error when incorrect auto-bridge coordinator address was
    ///         provided.
    error IncorrectAutoBridgeCoordinatorAddress(address autoBridgeCoordinator);

    /// @notice Error when incorrect deposit global unlock at timestamp was
    ///         provided.
    error IncorrectDepositGlobalUnlockAt(uint32 depositGlobalUnlockAt);

    /// @notice Error when tokens cannot be approved for bridging to Mezo.
    error TokenApprovalFailure();

    /// @notice Error when the caller is not the auto-bridge coordinator.
    error CallerNotAutoBridgeCoordinator();

    /// @notice Error when auto-bridging of WBTC token has been requested.
    error WbtcAutoBridgingNotSupported();

    /// @notice Error when unauthorized reentrant call is made.
    error ReentrancyGuardReentrantCall();

    /// @notice Modifier for preventing reentrant calls to a function. The code
    ///         was copied with some modifications from
    ///         https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.3.0/contracts/utils/ReentrancyGuard.sol
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    modifier onlyAutoBridgeCoordinator() {
        if (msg.sender != autoBridgeCoordinator) {
            revert CallerNotAutoBridgeCoordinator();
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract with the supported tokens and their
    ///         abilities.
    /// @dev We are using OpenZeppelin's initializer pattern to initialize
    ///      the contract. This function is called only once during the contract
    ///      deployment.
    /// @param supportedTokens List of supported tokens and their abilities
    function initialize(
        SupportedToken[] memory supportedTokens
    ) external initializer {
        __Ownable_init(msg.sender);

        minLockPeriod = 4 weeks;
        maxLockPeriod = 39 weeks;
        depositCount = 0;

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i].token;
            TokenAbility ability = supportedTokens[i].tokenAbility;

            if (token == address(0)) {
                revert IncorrectTokenAddress(token);
            }

            tokenAbility[token] = ability;
        }
    }

    /// @notice Withdraws all deposited tokens.
    ///
    ///         Deposited lockable tokens can be withdrawn at any time if
    ///         there is no lock set on the deposit or the deposit's lock period
    ///         has passed or the global unlock timestamp has passed.
    ///         There is no way to withdraw locked deposit. Tokens that are not
    ///         lockable can be withdrawn at any time.
    ///
    ///         Deposits for which receipt tokens were minted and not fully
    ///         repaid can not be withdrawn even if the lock expired. Repaying
    ///         all receipt tokens is a must to withdraw the deposit. Upon
    ///         withdrawing a deposit for which the receipt tokens were minted,
    ///         the fee is collected based on the annual fee and the amount
    ///         of minted receipt tokens.
    ///
    ///         Deposits for which to-tBTC migration was requested but not yet
    ///         completed yet can not be withdrawn. The deposits for which the
    ///         to-tBTC migration was completed are withdrawn in tBTC.
    ///
    ///         This function withdraws all deposited tokens. For partial
    ///         withdrawals, use `withdrawPartially`.
    /// @param token deposited token address
    /// @param depositId id of the deposit
    function withdraw(address token, uint256 depositId) external {
        TokenAbility ability = tokenAbility[token];

        if (ability == TokenAbility.None) {
            revert TokenNotSupported(token);
        }

        DepositInfo storage selectedDeposit = deposits[msg.sender][token][
            depositId
        ];

        if (
            selectedDeposit.tbtcMigrationState ==
            TbtcMigrationState.Requested ||
            selectedDeposit.tbtcMigrationState == TbtcMigrationState.InProgress
        ) {
            revert TbtcMigrationNotCompleted();
        }

        if (
            ability == TokenAbility.DepositAndLock &&
            // solhint-disable-next-line not-rely-on-time
            block.timestamp < selectedDeposit.unlockAt &&
            (depositGlobalUnlockAt == 0 ||
                // solhint-disable-next-line not-rely-on-time
                block.timestamp < depositGlobalUnlockAt)
        ) {
            revert DepositLocked(selectedDeposit.unlockAt);
        }

        if (selectedDeposit.receiptMinted > 0) {
            revert ReceiptNotRepaid(selectedDeposit.receiptMinted);
        }

        uint96 depositedAmount = selectedDeposit.balance;

        if (depositedAmount == 0) {
            revert DepositNotFound();
        }

        if (
            selectedDeposit.tbtcMigrationState == TbtcMigrationState.Completed
        ) {
            uint96 feeInTbtc = 0;

            // The fee is collected based on the pre-migration rules, so based
            // on the annual fee as set by the governance for the original token.
            // The fee is collected in tBTC as the entire deposit was migrated
            // to tBTC.
            if (selectedDeposit.feeOwed > 0) {
                FeeInfo storage tokenFeeInfo = feeInfo[token];

                feeInTbtc = _adjustTokenDecimals(
                    tokenFeeInfo.receiptToken,
                    tbtcToken,
                    selectedDeposit.feeOwed
                );
            }

            uint96 depositedAmountInTbtc = _adjustTokenDecimals(
                token,
                tbtcToken,
                depositedAmount
            );

            uint96 withdrawableInTbtc = depositedAmountInTbtc - feeInTbtc;

            emit WithdrawnTbtcMigrated(
                msg.sender,
                token,
                tbtcToken,
                depositId,
                withdrawableInTbtc
            );
            emit FeeCollectedTbtcMigrated(
                msg.sender,
                token,
                tbtcToken,
                depositId,
                feeInTbtc
            );

            feeInfo[tbtcToken].feeCollected += feeInTbtc;

            delete deposits[msg.sender][token][depositId];
            IERC20(tbtcToken).safeTransfer(msg.sender, withdrawableInTbtc);
        } else {
            uint96 fee = 0;

            if (selectedDeposit.feeOwed > 0) {
                FeeInfo storage tokenFeeInfo = feeInfo[token];

                fee = _adjustTokenDecimals(
                    tokenFeeInfo.receiptToken,
                    token,
                    selectedDeposit.feeOwed
                );
            }

            uint96 withdrawable = depositedAmount - fee;

            emit Withdrawn(msg.sender, token, depositId, withdrawable);
            emit FeeCollected(msg.sender, token, depositId, fee);

            feeInfo[token].feeCollected += fee;

            delete deposits[msg.sender][token][depositId];
            IERC20(token).safeTransfer(msg.sender, withdrawable);
        }
    }

    /// @notice Withdraws part of the deposited tokens.
    ///
    ///         Deposited lockable tokens can be withdrawn at any time if
    ///         there is no lock set on the deposit or the deposit's lock period
    ///         has passed or the global unlock timestamp has passed.
    ///         There is no way to withdraw locked deposit. Tokens that are not
    ///         lockable can be withdrawn at any time.
    ///
    ///         Deposits for which receipt tokens were minted and fully repaid
    ///         can not be partially withdrawn even if the lock expired.
    ///         Repaying all receipt tokens is a must to partially withdraw the
    ///         deposit. If the fee for receipt tokens minted is non-zero, the
    ///         deposit can not be partially withdrawn and only a full
    ///         withdrawal is possible.
    ///
    ///         Deposits for which the to-tBTC migration was requested can not
    ///         be withdrawn partially.
    ///
    ///         This function allows only for partial withdrawals. For full
    ///         withdrawals, use `withdraw`.
    /// @param token deposited token address
    /// @param depositId id of the deposit
    /// @param amount the amount to be withdrawn
    function withdrawPartially(
        address token,
        uint256 depositId,
        uint96 amount
    ) external {
        TokenAbility ability = tokenAbility[token];

        if (ability == TokenAbility.None) {
            revert TokenNotSupported(token);
        }

        if (amount == 0) {
            revert IncorrectAmount(amount);
        }

        DepositInfo storage selectedDeposit = deposits[msg.sender][token][
            depositId
        ];

        if (selectedDeposit.balance == 0) {
            revert DepositNotFound();
        }

        if (amount >= selectedDeposit.balance) {
            revert PartialWithdrawalAmountTooHigh(selectedDeposit.balance);
        }

        if (
            ability == TokenAbility.DepositAndLock &&
            // solhint-disable-next-line not-rely-on-time
            block.timestamp < selectedDeposit.unlockAt &&
            (depositGlobalUnlockAt == 0 ||
                // solhint-disable-next-line not-rely-on-time
                block.timestamp < depositGlobalUnlockAt)
        ) {
            revert DepositLocked(selectedDeposit.unlockAt);
        }

        if (selectedDeposit.receiptMinted > 0) {
            revert ReceiptNotRepaid(selectedDeposit.receiptMinted);
        }

        if (selectedDeposit.feeOwed > 0) {
            revert ReceiptFeeOwed(selectedDeposit.feeOwed);
        }

        if (
            selectedDeposit.tbtcMigrationState !=
            TbtcMigrationState.NotRequested
        ) {
            revert TbtcMigrationRequestedErr();
        }

        emit Withdrawn(msg.sender, token, depositId, amount);
        selectedDeposit.balance -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /// @notice Receive approval from a token contract and deposit the tokens in
    ///         one transaction. If the the token is lockable and lock period is
    ///         greater than 0, the deposit will be locked for the given period.
    /// @dev This function is called by the token following the `approveAndCall`
    ///      pattern.
    //       Encoded lock period is counted in seconds, will be normalized to
    ///      weeks. If non-zero, it must not be shorter than the minimum lock
    ///      period and must not be longer than the maximum lock period. To not
    ///      lock the deposit, the lock period must be 0.
    /// @param from address which approved and sent the tokens
    /// @param amount amount of tokens sent
    /// @param token address of the token contract
    /// @param data encoded lock period
    function receiveApproval(
        address from,
        uint256 amount,
        address token,
        bytes calldata data
    ) external override {
        if (token != msg.sender) {
            revert IncorrectTokenAddress(token);
        }
        if (amount > type(uint96).max) {
            revert IncorrectAmount(amount);
        }

        uint32 lockPeriod = abi.decode(data, (uint32));

        _depositFor(from, from, token, uint96(amount), lockPeriod);
    }

    /// @notice Deposit and optionally lock tokens for the given period.
    /// @dev Lock period will be normalized to weeks. If non-zero, it must not
    ///      be shorter than the minimum lock period and must not be longer than
    ///      the maximum lock period.
    /// @param token token address to deposit
    /// @param amount amount of tokens to deposit
    /// @param lockPeriod lock period in seconds, 0 to not lock the deposit
    function deposit(address token, uint96 amount, uint32 lockPeriod) external {
        _depositFor(msg.sender, msg.sender, token, amount, lockPeriod);
    }

    /// @notice Deposit and optionally lock tokens to the contract on behalf of
    ///         someone else.
    /// @dev Lock period will be normalized to weeks. If non-zero, it must not
    ///      be shorter than the minimum lock period and must not be longer than
    ///      the maximum lock period.
    /// @param depositOwner address that will be able to withdraw the deposit
    /// @param token token address to deposit
    /// @param amount amount of tokens to deposit
    /// @param lockPeriod lock period in seconds, 0 to not lock the deposit
    function depositFor(
        address depositOwner,
        address token,
        uint96 amount,
        uint32 lockPeriod
    ) external {
        _depositFor(depositOwner, msg.sender, token, amount, lockPeriod);
    }

    /// @notice Lock existing deposit for a given period. This function can be
    ///         used to lock a deposit that was not locked when it was created or
    ///         to extend the lock period of an already locked deposit.
    /// @param token address of the deposited token
    /// @param depositId id of the deposit
    /// @param lockPeriod new lock period in seconds
    function lock(
        address token,
        uint256 depositId,
        uint32 lockPeriod
    ) external {
        DepositInfo storage depositInfo = deposits[msg.sender][token][
            depositId
        ];

        if (depositInfo.balance == 0) {
            revert DepositNotFound();
        }

        TokenAbility ability = tokenAbility[token];
        if (ability != TokenAbility.DepositAndLock) {
            revert InsufficientTokenAbility(token, ability);
        }

        uint32 existingUnlockAt = depositInfo.unlockAt;
        uint32 newUnlockAt = _calculateUnlockTime(
            msg.sender,
            token,
            depositId,
            lockPeriod
        );
        if (newUnlockAt <= existingUnlockAt) {
            revert LockPeriodTooShort(
                lockPeriod,
                newUnlockAt,
                existingUnlockAt
            );
        }

        depositInfo.unlockAt = newUnlockAt;
    }

    /// @notice External withdraw function to enable the liquidity treasury to
    ///         withdraw tokens from the contract. Only the liquidity treasury
    ///         can withdraw tokens from the contract using this function.
    /// @param token token address to withdraw
    /// @param amount amount of respective token to withdraw
    function withdrawAsLiquidityTreasury(
        address token,
        uint256 amount
    ) external {
        if (msg.sender != liquidityTreasury) {
            revert SenderNotLiquidityTreasury(msg.sender);
        }

        if (amount == 0) {
            revert IncorrectAmount(amount);
        }

        if (!liquidityTreasuryManaged[token]) {
            revert AssetNotManagedByLiquidityTreasury(token);
        }

        emit WithdrawnByLiquidityTreasury(token, amount);

        IERC20(token).safeTransfer(msg.sender, amount);
    }

    /// @notice Repay the deposit receipt token of a particular deposit.
    /// @param token the token address related with the deposit
    /// @param depositId the ID of the deposit
    /// @param amount how much of the token to repay, up to outstanding balance
    function repayReceipt(
        address token,
        uint256 depositId,
        uint256 amount
    ) public {
        FeeInfo storage fee = feeInfo[token];

        if (fee.receiptToken == address(0)) {
            revert ReceiptMintingDisabled();
        }

        if (amount == 0) {
            revert IncorrectAmount(amount);
        }

        DepositInfo storage depositInfo = deposits[msg.sender][token][
            depositId
        ];

        if (depositInfo.balance == 0) {
            revert DepositNotFound();
        }

        if (depositInfo.receiptMinted < amount) {
            revert RepayAmountExceededDebt(depositInfo.receiptMinted, amount);
        }

        _updateFee(depositInfo, token);

        depositInfo.receiptMinted -= uint96(amount);
        fee.totalMinted -= uint96(amount);

        emit ReceiptRepaid(msg.sender, token, depositId, amount);

        // transfer the repaid receipt tokens and burn them
        IERC20(fee.receiptToken).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );

        IReceiptToken(fee.receiptToken).burnReceipt(amount);
    }

    /// @notice Used by the tBTC migration treasury to withdraw tokens from the
    ///         deposits marked by their owners as requested for to-tBTC
    ///         migration. The caller specifies which deposits are to begin the
    ///         migration. Calling this function for the deposit marks it
    ///         as to-tBTC migration started but gives no promise as when the
    ///         to-tBTC migration will be completed. For all deposits for which
    ///         the to-tBTC migration was started, the tBTC migration multisig
    ///         must ensure to call the `finalizeTbtcMigration` function once
    ///         the migration is completed.
    /// @param token deposited token address
    /// @param depositsToMigrate an array of deposits for which the to-tBTC
    ///        migration was requested and from which the assets should be
    ///        withdrawn for the to-tBTC migration
    function withdrawForTbtcMigration(
        address token,
        DepositToMigrate[] memory depositsToMigrate
    ) external {
        if (msg.sender != tbtcMigrationTreasury) {
            revert SenderNotTbtcMigrationTreasury();
        }

        uint96 totalToMigrate = 0;

        for (uint256 i = 0; i < depositsToMigrate.length; i++) {
            address depositOwner = depositsToMigrate[i].depositor;
            uint256 depositId = depositsToMigrate[i].depositId;

            DepositInfo storage depositInfo = deposits[depositOwner][token][
                depositId
            ];
            if (depositInfo.balance == 0) {
                revert DepositNotFound();
            }

            if (
                depositInfo.tbtcMigrationState != TbtcMigrationState.Requested
            ) {
                revert UnexpectedTbtcMigrationState(
                    depositId,
                    depositInfo.tbtcMigrationState,
                    TbtcMigrationState.Requested
                );
            }

            depositInfo.tbtcMigrationState = TbtcMigrationState.InProgress;
            totalToMigrate += depositInfo.balance;

            emit TbtcMigrationStarted(depositOwner, token, depositId);
        }

        TbtcMigrationInfo storage migrationInfo = tbtcMigrations[token];
        migrationInfo.totalMigrating += totalToMigrate;

        emit WithdrawnForTbtcMigration(token, totalToMigrate);

        IERC20(token).safeTransfer(tbtcMigrationTreasury, totalToMigrate);
    }

    /// @notice Used by the tBTC migration treasury to complete the to-tBTC
    ///         migration for the selected set of deposits. For all of those
    ///         deposits the migration should be started by calling
    ///         `withdrawForTbtcMigration` function before. The treasury has to
    ///         approve the amount of tBTC to the Portal contract equal to the
    ///         total migrated amount of the migrated deposits, adjusted to tBTC
    ///         token decimals.
    /// @param token pre-migration deposited token address
    /// @param migratedDeposits an array of deposits for which the to-tBTC
    ///        migration was completed
    function completeTbtcMigration(
        address token,
        DepositToMigrate[] memory migratedDeposits
    ) external {
        if (msg.sender != tbtcMigrationTreasury) {
            revert SenderNotTbtcMigrationTreasury();
        }

        uint96 totalMigrated = 0;

        for (uint256 i = 0; i < migratedDeposits.length; i++) {
            address depositOwner = migratedDeposits[i].depositor;
            uint256 depositId = migratedDeposits[i].depositId;

            DepositInfo storage depositInfo = deposits[depositOwner][token][
                depositId
            ];

            if (
                depositInfo.tbtcMigrationState != TbtcMigrationState.InProgress
            ) {
                revert UnexpectedTbtcMigrationState(
                    depositId,
                    depositInfo.tbtcMigrationState,
                    TbtcMigrationState.InProgress
                );
            }

            totalMigrated += depositInfo.balance;

            depositInfo.tbtcMigrationState = TbtcMigrationState.Completed;

            emit TbtcMigrationCompleted(depositOwner, token, depositId);
        }

        TbtcMigrationInfo storage migrationInfo = tbtcMigrations[token];
        migrationInfo.totalMigrating -= totalMigrated;

        uint96 totalMigratedInTbtc = _adjustTokenDecimals(
            token,
            tbtcToken,
            totalMigrated
        );

        emit FundedFromTbtcMigration(totalMigratedInTbtc);

        IERC20(tbtcToken).safeTransferFrom(
            msg.sender,
            address(this),
            totalMigratedInTbtc
        );
    }

    /// @notice Get the balance and unlock time of a given deposit. Note that
    ///         the deposit could be migrated to tBTC so even though the `token`
    ///         key under which it is available could still point to the
    ///         pre-migration version, the withdrawal - when requested - will
    ///         happen in tBTC.
    /// @param depositor depositor address
    /// @param token token address to get the balance
    /// @param depositId id of the deposit
    function getDeposit(
        address depositor,
        address token,
        uint256 depositId
    ) external view returns (DepositInfo memory) {
        return deposits[depositor][token][depositId];
    }

    /// @notice Set indication of whether the deposit should opt out from
    ///         auto-bridging to the Mezo chain. Can only be called by the
    ///         contract's owner. The deposit must exist.
    /// @param depositor depositor address
    /// @param token deposited token address
    /// @param depositId id of the deposit
    /// @param optOut indication of whether the deposit should opt-out from
    ///               auto-bridging
    function setDepositAutoBridgingOptOut(
        address depositor,
        address token,
        uint256 depositId,
        bool optOut
    ) external onlyOwner {
        _setDepositAutoBridgingOptOut(depositor, token, depositId, optOut);
    }

    /// @notice Set indication of whether the deposit should opt out from
    ///         auto-bridging to the Mezo chain. The caller must be the
    ///         deposit's owner. The deposit must exist.
    /// @param token deposited token address
    /// @param depositId id of the deposit
    /// @param optOut indication of whether the deposit should opt-out from
    ///               auto-bridging
    function setDepositAutoBridgingOptOut(
        address token,
        uint256 depositId,
        bool optOut
    ) external {
        _setDepositAutoBridgingOptOut(msg.sender, token, depositId, optOut);
    }

    /// @notice Set the Mezo bridge. It will be used during auto-bridging of
    ///         tokens to the Mezo chain.
    /// @param _mezoBridge address of the Mezo bridge
    function setMezoBridge(address _mezoBridge) external onlyOwner {
        if (_mezoBridge == address(0)) {
            revert IncorrectMezoBridgeAddress(_mezoBridge);
        }

        emit MezoBridgeUpdated(address(mezoBridge), _mezoBridge);
        mezoBridge = MezoBridge(_mezoBridge);
    }

    /// @notice Set the auto-bridge coordinator. This account will be able to
    ///         auto-bridge deposits to the Mezo chain.
    /// @param _autoBridgeCoordinator address of the auto-bridge coordinator
    function setAutoBridgeCoordinator(
        address _autoBridgeCoordinator
    ) external onlyOwner {
        if (_autoBridgeCoordinator == address(0)) {
            revert IncorrectAutoBridgeCoordinatorAddress(
                _autoBridgeCoordinator
            );
        }

        emit AutoBridgeCoordinatorUpdated(
            autoBridgeCoordinator,
            _autoBridgeCoordinator
        );
        autoBridgeCoordinator = _autoBridgeCoordinator;
    }

    /// @notice Set the deposit global unlock at timestamp beyond which all
    ///         deposits are withdrawable, irrespective of their `unlockAt`
    ///         parameter.
    /// @param _depositGlobalUnlockAt deposit global unlock at timestamp
    function setDepositGlobalUnlockAt(
        uint32 _depositGlobalUnlockAt
    ) external onlyOwner {
        if (_depositGlobalUnlockAt == 0) {
            revert IncorrectDepositGlobalUnlockAt(_depositGlobalUnlockAt);
        }

        emit DepositGlobalUnlockAtUpdated(
            depositGlobalUnlockAt,
            _depositGlobalUnlockAt
        );
        depositGlobalUnlockAt = _depositGlobalUnlockAt;
    }

    /// @notice Set the WBTC token address.
    /// @dev Can only be executed by the governance.
    /// @param _wbtcToken address of the WBTC token
    function setWbtcTokenAddress(address _wbtcToken) external onlyOwner {
        if (_wbtcToken == address(0)) {
            revert IncorrectTokenAddress(_wbtcToken);
        }

        wbtcToken = _wbtcToken;

        emit WbtcTokenAddressSet(_wbtcToken);
    }

    /// @notice Auto-bridge a batch of deposits to the Mezo chain via the Mezo
    ///         bridge contract.
    /// @param token address of token common to all the deposits on the list
    /// @param _deposits list of deposits to be auto-bridged
    /// @dev Can be called only by the auto-bridge coordinator. All the deposits
    ///      in the batch must be of the same token and the token must not be
    ///      WBTC.
    ///      A deposit will be skipped during auto-bridging if:
    ///      - the deposit is opting-out from auto-bridging, or
    ///      - the deposit was withdrawn, or
    ///      - stBTC was minted for the deposit and not repaid, or
    ///      - to-tBTC migration was requested for the deposit.
    ///      Before invoking this function, the contract owner must set the
    ///      addresses of Mezo bridge, tBTC and WBTC token.
    // slither-disable-next-line cyclomatic-complexity
    function autoBridgeDeposits(
        address token,
        DepositToAutoBridge[] calldata _deposits
    ) external nonReentrant onlyAutoBridgeCoordinator {
        if (wbtcToken == address(0)) {
            revert IncorrectTokenAddress(wbtcToken);
        }

        if (tbtcToken == address(0)) {
            revert IncorrectTokenAddress(tbtcToken);
        }

        if (address(mezoBridge) == address(0)) {
            revert IncorrectMezoBridgeAddress(address(mezoBridge));
        }

        if (token == wbtcToken) {
            revert WbtcAutoBridgingNotSupported();
        }

        for (uint256 i = 0; i < _deposits.length; i++) {
            address depositor = _deposits[i].depositor;
            uint256 depositId = _deposits[i].depositId;

            DepositInfo storage selectedDeposit = deposits[depositor][token][
                depositId
            ];

            if (selectedDeposit.autoBridgingOptOut) {
                // If the deposit is marked on-chain as opting-out from
                // auto-bridging skip it.
                emit OptOutDepositAutoBridgingSkipped(
                    depositor,
                    token,
                    depositId
                );
                continue;
            }

            uint256 depositBalance = selectedDeposit.balance;

            if (depositBalance == 0) {
                // Even though the provided list of deposits to auto-bridge
                // should be correctly constructed, we should skip a problematic
                // deposit rather than revert. This helps to avoid a griefing
                // attack when the attacker would front-run the auto-bridging
                // transaction and withdraw the deposit.
                emit WithdrawnDepositAutoBridgingSkipped(
                    depositor,
                    token,
                    depositId
                );
                continue;
            }

            if (selectedDeposit.receiptMinted > 0) {
                // Ignore deposits for which stBTC was minted and not repaid.
                // We need to keep them locked until the receipt token is
                // repaid.
                emit ReceiptMintedDepositAutoBridgingSkipped(
                    depositor,
                    token,
                    depositId
                );
                continue;
            }

            if (
                selectedDeposit.tbtcMigrationState !=
                TbtcMigrationState.NotRequested
            ) {
                // Ignore deposits for which to-tBTC migration was
                // requested. Those deposits will have to be handled by a
                // separate bridging function.
                emit TbtcMigratingDepositAutoBridgingSkipped(
                    depositor,
                    token,
                    depositId
                );
                continue;
            }

            delete deposits[depositor][token][depositId];

            // slither-disable-start reentrancy-no-eth
            // slither-disable-start calls-loop

            if (token == USDT_ADDRESS) {
                // Special case for USDT. Per ERC20 spec, approve should return
                // boolean but USDT ignores the spec and approve returns nothing.
                // Also, USDT reverts if there is already a non-zero approval.
                IUSDT(token).approve(address(mezoBridge), 0);
                IUSDT(token).approve(address(mezoBridge), depositBalance);
            } else if (
                !IERC20(token).approve(address(mezoBridge), depositBalance)
            ) {
                revert TokenApprovalFailure();
            }

            if (token == tbtcToken) {
                mezoBridge.bridgeTBTC(depositBalance, depositor);
            } else {
                mezoBridge.bridgeERC20(token, depositBalance, depositor);
            }

            emit DepositAutoBridged(
                depositor,
                token,
                depositId,
                depositBalance
            );

            // slither-disable-end reentrancy-no-eth
            // slither-disable-end calls-loop
        }
    }

    /// @notice Auto-bridges the provided WBTC deposits to Mezo. Only WBTC
    ///         deposits that have completed the to-tBTC migration can be
    ///         bridged. The call is made by the coordinator who controls the
    ///         auto-bridging process.
    /// @dev All the deposits must be WBTC deposits that completed to-tBTC
    ///      migration. A deposit will be skipped during auto-bridging if:
    ///      - the deposit is opting-out from auto-bridging, or
    ///      - the deposit was withdrawn, or
    ///      - stBTC was minted for the deposit and not repaid.
    ///      Before invoking this function, the contract owner must set the
    ///      addresses of Mezo bridge, tBTC, and WBTC token.
    // slither-disable-next-line cyclomatic-complexity
    function autoBridgeWbtcDeposits(
        DepositToAutoBridge[] calldata _deposits
    ) external nonReentrant onlyAutoBridgeCoordinator {
        if (wbtcToken == address(0)) {
            revert IncorrectTokenAddress(wbtcToken);
        }

        if (tbtcToken == address(0)) {
            revert IncorrectTokenAddress(tbtcToken);
        }

        if (address(mezoBridge) == address(0)) {
            revert IncorrectMezoBridgeAddress(address(mezoBridge));
        }

        address _wbtc = wbtcToken;
        address _tbtc = tbtcToken;

        uint8 wbtcSourceDecimals = IERC20WithDecimals(_wbtc).decimals();
        uint8 tbtcTargetDecimals = IERC20WithDecimals(_tbtc).decimals();

        for (uint256 i = 0; i < _deposits.length; i++) {
            address depositor = _deposits[i].depositor;
            uint256 depositId = _deposits[i].depositId;

            DepositInfo storage selectedDeposit = deposits[depositor][_wbtc][
                depositId
            ];

            if (selectedDeposit.autoBridgingOptOut) {
                // If the deposit is marked on-chain as opting-out from
                // auto-bridging skip it.
                emit OptOutDepositAutoBridgingSkipped(
                    depositor,
                    _wbtc,
                    depositId
                );
                continue;
            }

            uint96 depositBalance = selectedDeposit.balance;

            if (depositBalance == 0) {
                // Even though the provided list of deposits to auto-bridge
                // should be correctly constructed, we should skip a problematic
                // deposit rather than revert. This helps to avoid a griefing
                // attack when the attacker would front-run the transaction and
                // withdraw the deposit.
                emit WithdrawnDepositAutoBridgingSkipped(
                    depositor,
                    _wbtc,
                    depositId
                );
                continue;
            }

            if (selectedDeposit.receiptMinted > 0) {
                // Ignore deposits for which stBTC was minted and not repaid.
                // We need to keep them locked until the receipt token is
                // repaid.
                emit ReceiptMintedDepositAutoBridgingSkipped(
                    depositor,
                    _wbtc,
                    depositId
                );
                continue;
            }

            if (
                selectedDeposit.tbtcMigrationState !=
                TbtcMigrationState.Completed
            ) {
                revert TbtcMigrationNotCompleted();
            }

            delete deposits[depositor][_wbtc][depositId];

            // slither-disable-start reentrancy-no-eth
            // slither-disable-start calls-loop

            uint96 depositBalanceInTbtc = _adjustTokenDecimals(
                wbtcSourceDecimals,
                tbtcTargetDecimals,
                depositBalance
            );

            if (
                !IERC20(_tbtc).approve(
                    address(mezoBridge),
                    depositBalanceInTbtc
                )
            ) {
                revert TokenApprovalFailure();
            }

            mezoBridge.bridgeTBTC(depositBalanceInTbtc, depositor);

            emit DepositAutoBridged(
                depositor,
                _wbtc,
                depositId,
                depositBalance
            );

            // slither-disable-end reentrancy-no-eth
            // slither-disable-end calls-loop
        }
    }

    /// @notice Allows the deposit owner to bridge their deposit to Mezo.
    ///         An existing deposit can be bridged assuming the receipt token
    ///         was not minted OR it was fully repaid. If the token is WBTC,
    ///         the to-tBTC migration must be completed for bridging.
    // slither-disable-next-line cyclomatic-complexity
    function bridgeDeposit(address token, uint256 depositId) external {
        if (wbtcToken == address(0)) {
            revert IncorrectTokenAddress(wbtcToken);
        }

        if (tbtcToken == address(0)) {
            revert IncorrectTokenAddress(tbtcToken);
        }

        if (address(mezoBridge) == address(0)) {
            revert IncorrectMezoBridgeAddress(address(mezoBridge));
        }

        DepositInfo storage selectedDeposit = deposits[msg.sender][token][
            depositId
        ];
        uint96 depositBalance = selectedDeposit.balance;

        if (depositBalance == 0) {
            revert DepositNotFound();
        }

        if (selectedDeposit.receiptMinted > 0) {
            revert ReceiptNotRepaid(selectedDeposit.receiptMinted);
        }

        if (
            token == wbtcToken &&
            selectedDeposit.tbtcMigrationState != TbtcMigrationState.Completed
        ) {
            revert TbtcMigrationNotCompleted();
        } else if (
            token != wbtcToken &&
            selectedDeposit.tbtcMigrationState !=
            TbtcMigrationState.NotRequested
        ) {
            revert TbtcMigrationRequestedErr();
        }

        delete deposits[msg.sender][token][depositId];

        emit DepositBridged(msg.sender, token, depositId, depositBalance);

        //
        // This is a WBTC token with a to-tBTC migration completed. We need to
        // adjust the decimals, as the DeposiInfo is still stored for WBTC.
        // After adjusting decimals, we can bridge it as tBTC.
        //
        if (token == wbtcToken) {
            uint96 depositBalanceInTbtc = _adjustTokenDecimals(
                token,
                tbtcToken,
                depositBalance
            );

            if (
                !IERC20(tbtcToken).approve(
                    address(mezoBridge),
                    depositBalanceInTbtc
                )
            ) {
                revert TokenApprovalFailure();
            }

            mezoBridge.bridgeTBTC(depositBalanceInTbtc, msg.sender);
        } else {
            //
            // This is either tBTC or any other ERC20 that had no to-tBTC
            // migrations requested. We can bridge it without adjusting
            // decimals.
            //
            if (token == USDT_ADDRESS) {
                // Special case for USDT. Per ERC20 spec, approve should return
                // boolean but USDT ignores the spec and approve returns nothing.
                // Also, USDT reverts if there is already a non-zero approval.
                IUSDT(token).approve(address(mezoBridge), 0);
                IUSDT(token).approve(address(mezoBridge), depositBalance);
            } else if (
                !IERC20(token).approve(address(mezoBridge), depositBalance)
            ) {
                revert TokenApprovalFailure();
            }

            if (token == tbtcToken) {
                mezoBridge.bridgeTBTC(depositBalance, msg.sender);
            } else {
                mezoBridge.bridgeERC20(token, depositBalance, msg.sender);
            }
        }
    }

    /// @notice Internal function for marking a given deposit as opting-out from
    ///         auto-bridging to the Mezo chain. The deposit must exist.
    /// @param depositor depositor address
    /// @param token deposited token address
    /// @param depositId id of the deposit
    /// @param optOut indication of whether the deposit should opt-out from
    ///               auto-bridging
    function _setDepositAutoBridgingOptOut(
        address depositor,
        address token,
        uint256 depositId,
        bool optOut
    ) internal {
        DepositInfo storage selectedDeposit = deposits[depositor][token][
            depositId
        ];

        if (selectedDeposit.balance == 0) {
            revert DepositNotFound();
        }

        selectedDeposit.autoBridgingOptOut = optOut;

        emit DepositAutoBridgingOptOutSet(depositor, token, depositId, optOut);
    }

    /// @notice Internal deposit function to deposit tokens on behalf of a given
    ///         address - sender or someone else. If the lock period passed as
    ///         a parameter is non-zero, the function will lock the deposit.
    /// @param depositOwner address that will be able to withdraw the deposit
    /// @param token token address to deposit
    /// @param amount amount of tokens to deposit
    /// @param lockPeriod lock period in seconds, 0 to not lock the deposit
    function _depositFor(
        address depositOwner,
        address depositFunder,
        address token,
        uint96 amount,
        uint32 lockPeriod
    ) internal {
        TokenAbility ability = tokenAbility[token];
        if (ability == TokenAbility.None) {
            revert TokenNotSupported(token);
        }
        if (lockPeriod > 0 && ability == TokenAbility.Deposit) {
            revert InsufficientTokenAbility(token, ability);
        }

        if (depositOwner == address(0)) {
            revert IncorrectDepositor(depositOwner);
        }

        if (amount == 0) {
            revert IncorrectAmount(amount);
        }

        depositCount++;

        uint256 depositId = depositCount;

        emit Deposited(depositOwner, token, depositId, amount);

        deposits[depositOwner][token][depositId] = DepositInfo({
            balance: amount,
            // solhint-disable-next-line not-rely-on-time
            unlockAt: _calculateUnlockTime(
                depositOwner,
                token,
                depositId,
                lockPeriod
            ),
            receiptMinted: 0,
            feeOwed: 0,
            lastFeeIntegral: 0,
            tbtcMigrationState: TbtcMigrationState.NotRequested,
            autoBridgingOptOut: false
        });

        IERC20(token).safeTransferFrom(depositFunder, address(this), amount);
    }

    /// @notice Calculates the unlock time normalizing the lock time value and
    ///         making sure it is in the allowed range. Returns the timestamp at
    ///         which the deposit can be unlocked.
    /// @dev This function DOES NOT check if the deposit exists and if the
    ///      existing deposit already has a lock time. Please validate it before
    ///      calling this function.
    /// @param depositor depositor address
    /// @param token token of the deposit that will be locked
    /// @param depositId id of the deposit that will be locked
    /// @param lockPeriod lock period in seconds
    function _calculateUnlockTime(
        address depositor,
        address token,
        uint depositId,
        uint32 lockPeriod
    ) internal returns (uint32) {
        // Short-circuit if there is no intention to lock. There is no need to
        // check the minimum/maximum lock time or normalize the lock period.
        if (lockPeriod == 0) {
            // solhint-disable-next-line not-rely-on-time
            return uint32(block.timestamp);
        }

        uint32 normalizedLockPeriod = _normalizeLockPeriod(lockPeriod);

        if (
            normalizedLockPeriod == 0 ||
            normalizedLockPeriod < minLockPeriod ||
            normalizedLockPeriod > maxLockPeriod
        ) {
            revert LockPeriodOutOfRange(lockPeriod);
        }

        // solhint-disable-next-line not-rely-on-time
        uint32 unlockAt = uint32(block.timestamp) + normalizedLockPeriod;

        // It is gas-cheaper to pass the required parameters and emit the event
        // here instead of checking the result and emit the event in the calling
        // function. Keep in mind internal functions are inlined.
        emit Locked(
            depositor,
            token,
            depositId,
            unlockAt,
            normalizedLockPeriod
        );

        return unlockAt;
    }

    /// @notice Internal function to update the fee information of a given
    ///         deposit.
    /// @param depositInfo Storage reference to the deposit info to be updated.
    /// @param token Address of the token related to the deposit.
    function _updateFee(
        DepositInfo storage depositInfo,
        address token
    ) internal {
        _updateFeeIntegral(token);

        FeeInfo memory fee = feeInfo[token];

        depositInfo.feeOwed += _calculateFeeAccrued(
            fee.feeIntegral - depositInfo.lastFeeIntegral,
            depositInfo.receiptMinted
        );
        depositInfo.lastFeeIntegral = fee.feeIntegral;
    }

    /// @notice Internal function to update the fee integral for a given token.
    /// @param token Address of the token to update the fee integral.
    function _updateFeeIntegral(address token) internal {
        FeeInfo storage i = feeInfo[token];
        uint96 feePerSecond = _calculateFeeRate(token);

        // solhint-disable-next-line not-rely-on-time
        uint32 timeInterval = uint32(block.timestamp) - i.lastFeeUpdateAt;
        uint96 accumulated = timeInterval * feePerSecond;
        i.feeIntegral += uint88(accumulated);
        // solhint-disable-next-line not-rely-on-time
        i.lastFeeUpdateAt = uint32(block.timestamp);
    }

    /// @notice Internal function to calculate the fee rate per second for a
    ///         given token.
    /// @param token Address of the token.
    function _calculateFeeRate(address token) internal view returns (uint96) {
        FeeInfo memory i = feeInfo[token];
        // The i.annualFee is expressed in % so we divide by 100 to get the
        // fee rate in token units: 10^18 / 10^2 = 10^16
        return (uint96(i.annualFee) * (10 ** 16)) / (365 days);
    }

    /// @notice Calculates the fee accrued based on the given integral
    ///         difference and minted amount.
    /// @dev Multiplies the integral difference by the minted amount and scales
    ///      it down to fit the desired precision.
    /// @param integralDiff The difference in integral values.
    /// @param mintedAmount The amount of tokens minted.
    function _calculateFeeAccrued(
        uint88 integralDiff,
        uint96 mintedAmount
    ) internal pure returns (uint96) {
        return
            uint96((uint256(integralDiff) * uint256(mintedAmount)) / 10 ** 18);
    }

    /// @notice Normalizes the lock period to weeks. Will round down if not
    ///         normalized.
    /// @param lockPeriod the lock period to be normalized
    function _normalizeLockPeriod(
        uint32 lockPeriod
    ) internal pure returns (uint32) {
        // slither-disable-next-line divide-before-multiply
        return (lockPeriod / 1 weeks) * 1 weeks;
    }

    /// @notice Adjusts the decimals amount to desired precision for the two
    ///         token addresses and amount expressed in the precision used by
    ///         one of them.
    /// @param sourceToken the token address of the source amount
    /// @param targetToken the token address of the target amount
    /// @param amount the source amount to be adjusted
    function _adjustTokenDecimals(
        address sourceToken,
        address targetToken,
        uint96 amount
    ) internal view returns (uint96) {
        uint8 sourceDecimals = IERC20WithDecimals(sourceToken).decimals();
        uint8 targetDecimals = IERC20WithDecimals(targetToken).decimals();

        return _adjustTokenDecimals(sourceDecimals, targetDecimals, amount);
    }

    /// @notice Adjusts the decimals amount to desired precision for the two
    ///         token decimals and amount expressed in the precision used by
    ///         one of them.
    /// @param sourceDecimals the token decimals of the source amount
    /// @param targetDecimals the token decimals of the target amount
    /// @param amount the source amount to be adjusted
    function _adjustTokenDecimals(
        uint8 sourceDecimals,
        uint8 targetDecimals,
        uint96 amount
    ) internal pure returns (uint96) {
        if (sourceDecimals < targetDecimals) {
            return uint96(amount * (10 ** (targetDecimals - sourceDecimals)));
        } else if (sourceDecimals > targetDecimals) {
            return uint96(amount / (10 ** (sourceDecimals - targetDecimals)));
        }

        return amount;
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        // Any calls to nonReentrant after this point will fail
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = NOT_ENTERED;
    }
}
