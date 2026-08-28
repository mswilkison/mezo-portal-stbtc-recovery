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

    /// @notice The reviewed set of deposits with nonzero receipt debt for one
    ///         settled depositor. The stranding guard sums this depositor's
    ///         live debt over these ids, so every stBTC token they hold IN
    ///         THIS WALLET stays redeemable against debt they actually
    ///         retain. Ids must be strictly increasing. An id that no longer
    ///         carries debt simply contributes zero, and an omitted id only
    ///         makes the guard more conservative.
    ///
    ///         Scope limit: the guard can only price `balanceOf(depositor)`.
    ///         stBTC the same party holds indirectly — in an AMM pool, a
    ///         vault, or another address — is invisible to it, so the guard
    ///         is a floor, not a proof. Screening selected depositors for
    ///         externally-held stBTC is an off-chain review step
    ///         (scripts/check-external-stbtc.ts); see RECOVERY.md.
    struct DepositorContext {
        address depositor;
        uint256[] activeDepositIds;
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
    /// @notice Upper bound on the total receipt debt one `recoverTbtc` call
    ///         may request. The reviewed calldata fixes each round's exact
    ///         entries; capping (rather than pinning) the total lets a
    ///         residual round — after drift clamped an earlier round — reuse
    ///         this same reviewed implementation with fresh calldata instead
    ///         of redeploying for every residue.
    uint96 public immutable EXPECTED_MAX_RECOVERY_AMOUNT;

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
    error SettlementTotalExceedsMaximum(uint256 maximum, uint256 requested);
    error ZeroSettlementAmount(address depositor, uint256 depositId);
    error MissingDepositorContext(address depositor);
    error DepositNotInDepositorContext(address depositor, uint256 depositId);
    error DuplicateDepositorContext(address depositor);
    error InvalidDepositorContext(address depositor);
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
        uint96 expectedMaxRecoveryAmount
    ) {
        if (
            expectedPortal == address(0) ||
            recoveryAuthority == address(0) ||
            receiptPayer == address(0) ||
            collateralRecipient == address(0) ||
            expectedTbtc == address(0) ||
            expectedReceiptToken == address(0) ||
            expectedMaxRecoveryAmount == 0
        ) {
            revert ZeroConfigurationValue();
        }

        EXPECTED_PORTAL = expectedPortal;
        RECOVERY_AUTHORITY = recoveryAuthority;
        RECEIPT_PAYER = receiptPayer;
        COLLATERAL_RECIPIENT = collateralRecipient;
        EXPECTED_TBTC = expectedTbtc;
        EXPECTED_RECEIPT_TOKEN = expectedReceiptToken;
        EXPECTED_MAX_RECOVERY_AMOUNT = expectedMaxRecoveryAmount;

        _disableInitializers();
    }

    /// @notice Burns up to the configured maximum stBTC amount, releases the
    ///         same amount of tBTC, and reduces selected deposits' collateral
    ///         and receipt debt one-for-one.
    /// @dev Can only run as the call embedded in ProxyAdmin.upgradeAndCall.
    ///      The stBTC holder must first approve the Portal proxy for the
    ///      round's settlement total. Every state change and token transfer
    ///      reverts together if any check fails.
    ///
    ///      The requested settlement entries may not total more than the
    ///      immutable maximum, and the timelock batch commits their exact
    ///      contents, so only reviewed calldata can execute. Execution is
    ///      drift-tolerant within that reviewed selection: a deposit whose
    ///      state moved between review and execution (repaid, withdrawn,
    ///      migrating, or under-collateralized) is skipped or settled up to
    ///      its remaining debt rather than reverting the batch, because a
    ///      revert here would let any third-party depositor veto the whole
    ///      timelock operation with a 1 wei repayment.
    ///
    ///      Stranding guard: the normal Portal repayment path is keyed to the
    ///      deposit owner, so every stBTC token an owner holds needs matching
    ///      receipt debt somewhere in their deposits to stay redeemable. For
    ///      each settled owner, this call reads their live stBTC balance once
    ///      and their live debt across the reviewed `depositorContexts` id
    ///      list, and caps that owner's total settlement at debt minus
    ///      balance. A receipt-token transfer to a selected owner immediately
    ///      before execution can therefore only reduce the recovered amount —
    ///      first absorbed by the owner's unselected debt, never multiplied
    ///      per entry — and cannot leave the owner holding unredeemable stBTC
    ///      in the wallet this guard can see. Externally-held stBTC (AMM,
    ///      vault, another address) is outside its view; screening for that
    ///      is an off-chain review step described in RECOVERY.md.
    ///      The amount pulled, burned, and released always equals the debt
    ///      actually settled and never exceeds the immutable maximum.
    function recoverTbtc(
        ReceiptDebtSettlement[] calldata settlements,
        DepositorContext[] calldata depositorContexts
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

        uint256[] memory ownerSettleable = _computeOwnerSettleable(
            depositorContexts,
            token,
            receiptToken
        );

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

            uint256 contextIndex = _findDepositorContext(
                depositorContexts,
                settlement.depositor,
                settlement.depositId
            );

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

            // tBTC and the receipt token are verified above to share
            // decimals, so the owed fee reserves collateral one-for-one.
            uint96 feeReserve = deposit.feeOwed;

            if (uint256(deposit.receiptMinted) + feeReserve > deposit.balance) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.Undercollateralized
                );
                continue;
            }

            // Settle up to the deposit's remaining debt and up to the owner's
            // remaining non-stranding capacity. The skip check above
            // guarantees receiptMinted + feeReserve <= balance, so the
            // deposit stays fully collateralized (including its accrued
            // fees) after both reductions.
            uint96 settleAmount = settlement.amount;
            if (settleAmount > deposit.receiptMinted) {
                settleAmount = deposit.receiptMinted;
            }
            if (settleAmount > ownerSettleable[contextIndex]) {
                settleAmount = uint96(ownerSettleable[contextIndex]);
            }

            if (settleAmount == 0) {
                emit ReceiptDebtSettlementSkipped(
                    settlement.depositor,
                    token,
                    settlement.depositId,
                    SettlementSkipReason.ReceiptHolderWouldBeStranded
                );
                continue;
            }

            ownerSettleable[contextIndex] -= settleAmount;

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

        if (requestedTotal > EXPECTED_MAX_RECOVERY_AMOUNT) {
            revert SettlementTotalExceedsMaximum(
                EXPECTED_MAX_RECOVERY_AMOUNT,
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

    /// @dev For each reviewed depositor context, computes how much receipt
    ///      debt may be settled for that owner without leaving their live
    ///      stBTC balance unredeemable: the owner's live debt summed over
    ///      their reviewed active deposit ids, minus their live receipt-token
    ///      balance (floored at zero). Each owner's balance is read exactly
    ///      once. Settling any of the owner's deposits reduces their total
    ///      debt one-for-one, so decrementing this capacity per settlement
    ///      keeps the invariant `remaining debt >= balance` exact. Debt on a
    ///      deposit that entered tBTC migration is excluded, conservatively
    ///      treating it as not repayable through the normal path.
    function _computeOwnerSettleable(
        DepositorContext[] calldata depositorContexts,
        address token,
        address receiptToken
    ) internal view returns (uint256[] memory ownerSettleable) {
        ownerSettleable = new uint256[](depositorContexts.length);

        for (uint256 i = 0; i < depositorContexts.length; i++) {
            DepositorContext calldata context = depositorContexts[i];

            if (
                context.depositor == address(0) ||
                context.activeDepositIds.length == 0
            ) {
                revert InvalidDepositorContext(context.depositor);
            }
            for (uint256 j = 0; j < i; j++) {
                if (depositorContexts[j].depositor == context.depositor) {
                    revert DuplicateDepositorContext(context.depositor);
                }
            }

            uint256 liveDebt = 0;
            uint256 previousId = 0;
            for (uint256 j = 0; j < context.activeDepositIds.length; j++) {
                uint256 depositId = context.activeDepositIds[j];
                if (j > 0 && depositId <= previousId) {
                    revert InvalidDepositorContext(context.depositor);
                }
                previousId = depositId;

                DepositInfo storage deposit = deposits[context.depositor][
                    token
                ][depositId];
                if (
                    deposit.tbtcMigrationState ==
                    TbtcMigrationState.NotRequested
                ) {
                    liveDebt += deposit.receiptMinted;
                }
            }

            uint256 balance = IERC20(receiptToken).balanceOf(context.depositor);
            ownerSettleable[i] = liveDebt > balance ? liveDebt - balance : 0;
        }
    }

    /// @dev Every settlement entry's depositor must have exactly one reviewed
    ///      context, and the settled deposit must appear in that context's
    ///      reviewed id list. Both are calldata construction errors and revert
    ///      the batch: without the membership check the contract would accept
    ///      settling a deposit the reviewed context never listed, which the
    ///      off-chain preflight refuses to even print.
    function _findDepositorContext(
        DepositorContext[] calldata depositorContexts,
        address depositor,
        uint256 depositId
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < depositorContexts.length; i++) {
            if (depositorContexts[i].depositor == depositor) {
                uint256[] calldata ids = depositorContexts[i].activeDepositIds;
                for (uint256 j = 0; j < ids.length; j++) {
                    if (ids[j] == depositId) {
                        return i;
                    }
                }
                revert DepositNotInDepositorContext(depositor, depositId);
            }
        }
        revert MissingDepositorContext(depositor);
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
}
