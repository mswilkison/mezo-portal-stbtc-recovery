import { join } from "path"

// Single source of truth for the pinned recovery manifest. The hardhat
// config, the preflight script, and the fork test must all import the
// manifest from here so that re-pinning to a new snapshot only ever touches
// this file and the manifest it points at.
//
// The filename below is the ONLY place the pin appears: the parsed object,
// the resolved path (used for the operation-salt and provenance hashes), and
// the exported filename all derive from this one constant, so they can never
// disagree about which manifest is being validated, hashed, and encoded.
export const recoveryManifestFile = "mainnet-25850299.json"

export const recoveryManifestPath = join(
  __dirname,
  "..",
  "recovery",
  recoveryManifestFile,
)

export type ManifestSettlementPreState = {
  balanceWei: string
  receiptDebtWei: string
  feeOwedWei: string
  lastFeeIntegral: string
  migrationState: number
  feeAtSnapshotWei: string
  collateralMarginAtSnapshotWei: string
}

export type ManifestSettlement = {
  depositor: string
  depositId: string
  depositIdHex?: string
  amountWei: string
  // The depositor's stBTC holdings and total active receipt debt (across all
  // of their deposits) at the snapshot block. Captured so reviewers and the
  // preflight can verify the settlement cannot strand a depositor with stBTC
  // they can no longer redeem against their own debt.
  depositorStbtcBalanceWei: string
  depositorActiveDebtWei: string
  // Every deposit that had nonzero receipt debt for this depositor at the
  // snapshot, sorted ascending. The preflight re-reads these records at its
  // pinned block, and the recovery contract itself sums live debt over this
  // reviewed list for its stranding guard. Newly active records omitted from
  // this snapshot only make both recomputations conservative.
  depositorActiveDepositIds: string[]
  preState: ManifestSettlementPreState
}

export type StrandingExclusion = {
  depositor: string
  stbtcBalanceWei: string
  activeDebtWei: string
  depositIds: string[]
}

export type ManifestObservedState = {
  receiptPayerStbtcBalanceWei: string
  portalTbtcBalanceWei: string
  portalStbtcDebtWei: string
  depositCount: string
  activeTbtcDepositCount: number
  activeTbtcReceiptDebtWei: string
  feeInfo: {
    totalMintedWei: string
    lastFeeUpdateAt: number
    feeIntegral: string
    annualFeePercent: number
    mintCapPercent: number
    receiptToken: string
    feeCollectedWei: string
  }
}

export type RecoveryManifest = {
  chainId: number
  snapshotBlock: number
  snapshotTimestamp?: string
  selectionPolicy?: string
  addresses: {
    portal: string
    originalImplementation: string
    proxyAdmin: string
    proxyAdminOwnerTimelock: string
    portalLogicOwner: string
    tbtc: string
    stbtc: string
    receiptPayer: string
    collateralRecipient: string
  }
  implementationRuntimeHash: string
  recoveryAmountWei: string
  observedState: ManifestObservedState
  // Depositors excluded from settlement because they still hold stBTC they
  // could redeem against their own debt through the normal repayment path.
  strandingExclusions?: StrandingExclusion[]
  settlements: ManifestSettlement[]
}

// eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-dynamic-require, global-require
const manifestJson = require(`../recovery/${recoveryManifestFile}`)

export const recoveryManifest = manifestJson as RecoveryManifest
