// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.24;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IERC20WithDecimals.sol";
import "./interfaces/IReceiptToken.sol";
import "./MezoBridge.sol";

/// @notice Temporary Portal implementation for atomically exchanging a fixed
///         amount of stBTC for tBTC while reducing the corresponding Portal
///         receipt debt.
/// @dev This implementation is intentionally not a full Portal replacement.
///      Governance must install it with `upgradeAndCall` and restore the
///      original Portal implementation in the same TimelockController batch.
///      Its storage declarations exactly mirror the current Portal layout.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
// solhint-disable-next-line max-states-count
contract PortalStbtcRecovery is Ownable2StepUpgradeable {
    using SafeERC20 for IERC20;

    enum TokenAbility {
        None,
        Deposit,
        DepositAndLock
    }

    enum TbtcMigrationState {
        NotRequested,
        Requested,
        InProgress,
        Completed
    }

    struct DepositInfo {
        uint96 balance;
        uint32 unlockAt;
        uint96 receiptMinted;
        uint96 feeOwed;
        uint88 lastFeeIntegral;
        TbtcMigrationState tbtcMigrationState;
        bool autoBridgingOptOut;
    }

    struct TbtcMigrationInfo {
        bool isAllowed;
        uint96 totalMigrating;
    }

    struct FeeInfo {
        uint96 totalMinted;
        uint32 lastFeeUpdateAt;
        uint88 feeIntegral;
        uint8 annualFee;
        uint8 mintCap;
        address receiptToken;
        uint96 feeCollected;
    }

    struct ReceiptDebtSettlement {
        address depositor;
        uint256 depositId;
        uint96 amount;
    }

    /// @notice Reason a manifest settlement entry was skipped instead of
    ///         settled. Entries are skipped, not reverted, so that ordinary
    ///         third-party deposit activity between manifest review and
    ///         timelock execution (repayments, withdrawals, migrations)
    ///         cannot veto the whole recovery batch.
    enum SettlementSkipReason {
        DepositNotFound,
        DepositMigrating,
        DebtAlreadyRepaid,
        Undercollateralized,
        ReceiptHolderWouldBeStranded
    }

    // ---------------------------------------------------------------------
    // Portal storage. Do not add, remove, reorder, or change these fields.
    // ---------------------------------------------------------------------

    mapping(address => mapping(address => mapping(uint256 => DepositInfo)))
        public deposits;
    uint256 public depositCount;
    mapping(address => TokenAbility) public tokenAbility;
    uint32 public minLockPeriod;
    uint32 public maxLockPeriod;
    address public liquidityTreasury;
    mapping(address => bool) public liquidityTreasuryManaged;
    mapping(address => FeeInfo) public feeInfo;
    address public tbtcToken;
    address public tbtcMigrationTreasury;
    mapping(address => TbtcMigrationInfo) public tbtcMigrations;
    MezoBridge public mezoBridge;
    address public autoBridgeCoordinator;
    uint32 public depositGlobalUnlockAt;
    address public wbtcToken;
    uint256 private _status;

    // ---------------------------------------------------------------------
    // Immutable recovery configuration. Immutables do not consume proxy
    // storage and make the temporary implementation specific to one recovery.
    // ---------------------------------------------------------------------

    address public immutable EXPECTED_PORTAL;
    address public immutable RECOVERY_AUTHORITY;
    address public immutable RECEIPT_PAYER;
    address public immutable COLLATERAL_RECIPIENT;
    address public immutable EXPECTED_TBTC;
    address public immutable EXPECTED_RECEIPT_TOKEN;
    uint96 public immutable EXPECTED_RECOVERY_AMOUNT;

    uint256 private constant NOT_ENTERED = 0;
    uint256 private constant ENTERED = 1;

    event ReceiptDebtSettled(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        uint256 amount
    );

    event ReceiptDebtSettlementSkipped(
        address indexed depositor,
        address indexed token,
        uint256 indexed depositId,
        SettlementSkipReason reason
    );

    event StbtcRecoveryCompleted(
        address indexed receiptPayer,
        address indexed collateralRecipient,
        uint256 amount
    );

    error ZeroConfigurationValue();
    error UnauthorizedRecoveryCaller(address caller);
    error UnexpectedPortal(address portal);
    error UnexpectedTbtcToken(address token);
    error UnexpectedReceiptToken(address token);
    error UnexpectedTokenDecimals(uint8 tbtcDecimals, uint8 receiptDecimals);
    error EmptySettlements();
    error IncorrectSettlementAmount(uint256 expected, uint256 actual);
    error ZeroSettlementAmount(address depositor, uint256 depositId);
    error NothingSettled();
    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        _status = ENTERED;
        _;
        _status = NOT_ENTERED;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(
        address expectedPortal,
        address recoveryAuthority,
        address receiptPayer,
        address collateralRecipient,
        address expectedTbtc,
        address expectedReceiptToken,
        uint96 expectedRecoveryAmount
    ) {
        if (
            expectedPortal == address(0) ||
            recoveryAuthority == address(0) ||
            receiptPayer == address(0) ||
            collateralRecipient == address(0) ||
            expectedTbtc == address(0) ||
            expectedReceiptToken == address(0) ||
            expectedRecoveryAmount == 0
        ) {
            revert ZeroConfigurationValue();
        }

        EXPECTED_PORTAL = expectedPortal;
        RECOVERY_AUTHORITY = recoveryAuthority;
        RECEIPT_PAYER = receiptPayer;
        COLLATERAL_RECIPIENT = collateralRecipient;
        EXPECTED_TBTC = expectedTbtc;
        EXPECTED_RECEIPT_TOKEN = expectedReceiptToken;
        EXPECTED_RECOVERY_AMOUNT = expectedRecoveryAmount;

        _disableInitializers();
    }

    /// @notice Burns up to the configured stBTC amount, releases the same
    ///         amount of tBTC, and reduces selected deposits' collateral and
    ///         receipt debt one-for-one.
    /// @dev Can only run as the call embedded in ProxyAdmin.upgradeAndCall.
    ///      The stBTC holder must first approve the Portal proxy for exactly
    ///      the configured recovery amount. Every state change and token
    ///      transfer reverts together if any check fails.
    ///
    ///      The requested settlement entries must total exactly the immutable
    ///      recovery amount, so the reviewed calldata cannot change. Execution
    ///      is drift-tolerant within that reviewed selection: a deposit whose
    ///      state moved between review and execution (repaid, withdrawn,
    ///      migrating, or under-collateralized) is skipped or settled up to
    ///      its remaining debt rather than reverting the batch, because a
    ///      revert here would let any third-party depositor veto the whole
    ///      timelock operation with a 1 wei repayment. The amount pulled,
    ///      burned, and released always equals the debt actually settled and
    ///      never exceeds the immutable recovery amount. Each deposit also
    ///      retains at least its owner's live stBTC balance, so a receipt-token
    ///      transfer immediately before execution can clamp the recovery but
    ///      cannot strand that owner without debt they can repay.
    function recoverTbtc(
        ReceiptDebtSettlement[] calldata settlements
    ) external nonReentrant returns (uint256 totalSettled) {
        if (address(this) != EXPECTED_PORTAL) {
            revert UnexpectedPortal(address(this));
        }

        if (msg.sender != RECOVERY_AUTHORITY) {
            revert UnauthorizedRecoveryCaller(msg.sender);
        }

        if (settlements.length == 0) {
            revert EmptySettlements();
        }

        address token = tbtcToken;
        if (token != EXPECTED_TBTC) {
            revert UnexpectedTbtcToken(token);
        }

        FeeInfo storage fee = feeInfo[token];
        address receiptToken = fee.receiptToken;
        if (receiptToken != EXPECTED_RECEIPT_TOKEN) {
            revert UnexpectedReceiptToken(receiptToken);
        }

        uint8 receiptDecimals = IERC20WithDecimals(receiptToken).decimals();
        uint8 tbtcDecimals = IERC20WithDecimals(token).decimals();
        if (receiptDecimals != tbtcDecimals) {
            revert UnexpectedTokenDecimals(tbtcDecimals, receiptDecimals);
        }

        uint256 requestedTotal = 0;
        for (uint256 i = 0; i < settlements.length; i++) {
            ReceiptDebtSettlement calldata settlement = settlements[i];

            if (settlement.amount == 0) {
                revert ZeroSettlementAmount(
                    settlement.depositor,
                    settlement.depositId
                );
            }
            requestedTotal += settlement.amount;

            DepositInfo storage deposit = deposits[settlement.depositor][token][
                settlement.depositId
            ];

            if (deposit.balance == 0) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.DepositNotFound
                );
                continue;
            }

            if (deposit.tbtcMigrationState != TbtcMigrationState.NotRequested) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.DepositMigrating
                );
                continue;
            }

            if (deposit.receiptMinted == 0) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.DebtAlreadyRepaid
                );
                continue;
            }

            _updateFee(deposit, token);

            uint96 feeReserve = _adjustTokenDecimals(
                receiptDecimals,
                tbtcDecimals,
                deposit.feeOwed
            );

            if (uint256(deposit.receiptMinted) + feeReserve > deposit.balance) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.Undercollateralized
                );
                continue;
            }

            // Settle up to the deposit's remaining debt. The skip check above
            // guarantees receiptMinted + feeReserve <= balance, so the deposit
            // stays fully collateralized (including its accrued fees) after
            // both reductions.
            uint96 settleAmount = settlement.amount;
            if (settleAmount > deposit.receiptMinted) {
                settleAmount = deposit.receiptMinted;
            }

            // The normal Portal repayment path is keyed by msg.sender, so an
            // owner needs enough debt in one of their deposits to redeem every
            // stBTC token they currently hold. This live balance check closes
            // the preflight-to-execution race atomically. Reserving the full
            // balance in each selected deposit is intentionally conservative:
            // it does not rely on enumerating the owner's other deposits.
            uint256 depositorReceiptBalance = IERC20(receiptToken).balanceOf(
                settlement.depositor
            );
            if (depositorReceiptBalance >= deposit.receiptMinted) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.ReceiptHolderWouldBeStranded
                );
                continue;
            }

            uint96 maxNonStrandingSettlement = deposit.receiptMinted -
                uint96(depositorReceiptBalance);
            if (settleAmount > maxNonStrandingSettlement) {
                settleAmount = maxNonStrandingSettlement;
            }

            deposit.balance -= settleAmount;
            deposit.receiptMinted -= settleAmount;
            fee.totalMinted -= settleAmount;
            totalSettled += settleAmount;

            emit ReceiptDebtSettled(
                settlement.depositor,
                token,
                settlement.depositId,
                settleAmount
            );
        }

        if (requestedTotal != EXPECTED_RECOVERY_AMOUNT) {
            revert IncorrectSettlementAmount(
                EXPECTED_RECOVERY_AMOUNT,
                requestedTotal
            );
        }

        if (totalSettled == 0) {
            revert NothingSettled();
        }

        IERC20(receiptToken).safeTransferFrom(
            RECEIPT_PAYER,
            address(this),
            totalSettled
        );
        IReceiptToken(receiptToken).burnReceipt(totalSettled);
        IERC20(token).safeTransfer(COLLATERAL_RECIPIENT, totalSettled);

        emit StbtcRecoveryCompleted(
            RECEIPT_PAYER,
            COLLATERAL_RECIPIENT,
            totalSettled
        );
    }

    function _updateFee(DepositInfo storage deposit, address token) internal {
        _updateFeeIntegral(token);

        FeeInfo memory fee = feeInfo[token];
        deposit.feeOwed += _calculateFeeAccrued(
            fee.feeIntegral - deposit.lastFeeIntegral,
            deposit.receiptMinted
        );
        deposit.lastFeeIntegral = fee.feeIntegral;
    }

    function _updateFeeIntegral(address token) internal {
        FeeInfo storage fee = feeInfo[token];
        uint96 feePerSecond = (uint96(fee.annualFee) * (10 ** 16)) / (365 days);

        // solhint-disable-next-line not-rely-on-time
        uint32 timeInterval = uint32(block.timestamp) - fee.lastFeeUpdateAt;
        fee.feeIntegral += uint88(timeInterval * feePerSecond);
        // solhint-disable-next-line not-rely-on-time
        fee.lastFeeUpdateAt = uint32(block.timestamp);
    }

    function _calculateFeeAccrued(
        uint88 integralDiff,
        uint96 mintedAmount
    ) internal pure returns (uint96) {
        return
            uint96((uint256(integralDiff) * uint256(mintedAmount)) / 10 ** 18);
    }

    function _adjustTokenDecimals(
        uint8 sourceDecimals,
        uint8 targetDecimals,
        uint96 amount
    ) internal pure returns (uint96) {
        if (sourceDecimals < targetDecimals) {
            return uint96(amount * (10 ** (targetDecimals - sourceDecimals)));
        }

        if (sourceDecimals > targetDecimals) {
            return uint96(amount / (10 ** (sourceDecimals - targetDecimals)));
        }

        return amount;
    }
}
