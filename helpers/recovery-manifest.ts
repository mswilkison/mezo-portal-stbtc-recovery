import { join } from "path"

// Single source of truth for the pinned recovery manifest. The hardhat
// config, the preflight script, and the fork test must all import the
// manifest from here so that re-pinning to a new snapshot only ever touches
// this file and the manifest it points at.
import manifestJson from "../recovery/mainnet-25850299.json"

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
  depositorStbtcBalanceWei?: string
  depositorActiveDebtWei?: string
  preState: ManifestSettlementPreState
}

export type StrandingExclusion = {
  depositor: string
  stbtcBalanceWei: string
  activeDebtWei: string
  depositIds: string[]
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
  observedState?: Record<string, unknown>
  // Depositors excluded from settlement because they still hold stBTC they
  // could redeem against their own debt through the normal repayment path.
  strandingExclusions?: StrandingExclusion[]
  settlements: ManifestSettlement[]
}

export const recoveryManifestFile = "mainnet-25850299.json"

export const recoveryManifestPath = join(
  __dirname,
  "..",
  "recovery",
  recoveryManifestFile,
)

export const recoveryManifest = manifestJson as unknown as RecoveryManifest
