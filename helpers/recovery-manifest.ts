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

let cachedManifest: RecoveryManifest | undefined

// The manifest is JSON cast to a type, so nothing enforces its shape at
// runtime. That matters most for the numeric fields: the preflight decides
// whether to apply its fatal snapshot-block checks with a strict `===`
// against snapshotBlock, so a quoted "25850299" would silently demote nine
// hard checks to warnings and still print a green run. Validate the shape
// where a wrong type changes behavior rather than merely crashing.
export function validateManifestShape(manifest: RecoveryManifest): void {
  const problems: string[] = []
  const requireInteger = (label: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      problems.push(`${label} must be a JSON number, got ${typeof value}`)
    }
  }
  const requireDecimalString = (label: string, value: unknown) => {
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
      problems.push(
        `${label} must be a decimal wei string, got ${typeof value}`,
      )
    }
  }

  requireInteger("chainId", manifest.chainId)
  requireInteger("snapshotBlock", manifest.snapshotBlock)
  requireDecimalString("recoveryAmountWei", manifest.recoveryAmountWei)

  if (
    !Array.isArray(manifest.settlements) ||
    manifest.settlements.length === 0
  ) {
    problems.push("settlements must be a non-empty array")
  } else {
    manifest.settlements.forEach((settlement, index) => {
      const at = `settlements[${index}]`
      requireDecimalString(`${at}.amountWei`, settlement.amountWei)
      requireDecimalString(`${at}.depositId`, settlement.depositId)
      requireDecimalString(
        `${at}.depositorStbtcBalanceWei`,
        settlement.depositorStbtcBalanceWei,
      )
      requireDecimalString(
        `${at}.depositorActiveDebtWei`,
        settlement.depositorActiveDebtWei,
      )
      requireInteger(
        `${at}.preState.migrationState`,
        settlement.preState?.migrationState,
      )
      if (
        !Array.isArray(settlement.depositorActiveDepositIds) ||
        settlement.depositorActiveDepositIds.length === 0
      ) {
        problems.push(
          `${at}.depositorActiveDepositIds must be a non-empty array`,
        )
      }
    })
  }

  // Optional in the type only so older manifests parse; the preflight and
  // fork test both rely on these, so a manifest missing them is rejected
  // rather than silently skipping the checks built on them.
  if (!Array.isArray(manifest.strandingExclusions)) {
    problems.push(
      "strandingExclusions must be present (use [] when nothing was excluded)",
    )
  } else {
    const exclusionDepositors = new Set<string>()
    manifest.strandingExclusions.forEach((exclusion, index) => {
      const at = `strandingExclusions[${index}]`
      requireDecimalString(`${at}.stbtcBalanceWei`, exclusion.stbtcBalanceWei)
      requireDecimalString(`${at}.activeDebtWei`, exclusion.activeDebtWei)
      if (
        !Array.isArray(exclusion.depositIds) ||
        exclusion.depositIds.length === 0
      ) {
        problems.push(`${at}.depositIds must be a non-empty array`)
      } else {
        exclusion.depositIds.forEach((depositId, depositIndex) =>
          requireDecimalString(`${at}.depositIds[${depositIndex}]`, depositId),
        )
      }

      if (typeof exclusion.depositor !== "string") {
        problems.push(`${at}.depositor must be a string`)
      } else {
        const normalized = exclusion.depositor.toLowerCase()
        if (exclusionDepositors.has(normalized)) {
          problems.push(
            `${at}.depositor duplicates another stranding exclusion`,
          )
        }
        exclusionDepositors.add(normalized)
      }
    })
  }
  if (!manifest.observedState?.feeInfo) {
    problems.push("observedState.feeInfo must be present")
  }

  if (problems.length > 0) {
    throw new Error(
      `recovery manifest ${recoveryManifestFile} is malformed:\n  - ${problems.join(
        "\n  - ",
      )}`,
    )
  }
}

// Loads the pinned manifest, failing with a message that names the pin and
// the fix instead of a bare MODULE_NOT_FOUND. Scripts and tests that cannot
// work without the manifest should call this and let it throw.
export function loadRecoveryManifest(): RecoveryManifest {
  if (!cachedManifest) {
    try {
      // Validate a local candidate before publishing it through the shared
      // module cache. hardhat.config.ts deliberately catches malformed-pin
      // errors through tryLoadRecoveryManifest(); assigning first would let
      // that caught object bypass validation in every later caller.
      // eslint-disable-next-line @typescript-eslint/no-var-requires, import/no-dynamic-require, global-require
      const manifest = require(
        `../recovery/${recoveryManifestFile}`,
      ) as RecoveryManifest
      validateManifestShape(manifest)
      cachedManifest = manifest
    } catch (error) {
      throw new Error(
        `failed to load the pinned recovery manifest ${recoveryManifestPath}: ` +
          `${(error as Error).message}. After a re-pin, recoveryManifestFile ` +
          "in helpers/recovery-manifest.ts must name a committed file in " +
          "recovery/",
      )
    }
  }
  return cachedManifest
}

// For callers that can degrade gracefully without the manifest — the hardhat
// config uses this so a broken pin does not take down every hardhat command
// (including the generator needed to produce a replacement manifest).
export function tryLoadRecoveryManifest(): RecoveryManifest | undefined {
  try {
    return loadRecoveryManifest()
  } catch {
    return undefined
  }
}
