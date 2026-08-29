// Independently reviewed constants for the recovery.
//
// These exist so the generated manifest is not its own authority. The
// generator DERIVES most of the manifest from chain state, but a few values
// cannot be derived — above all `collateralRecipient`, the destination of
// every released tBTC, which no on-chain state anchors. Before this file the
// generator copied that address forward from the previous manifest and the
// bytecode verifier checked the deployed immutable against the same manifest,
// so a corrupted address would be faithfully "verified".
//
// Every value here must be confirmed against a source OUTSIDE this repository
// (a signed governance record, the Safe's own UI, Etherscan) and changed only
// by a reviewed commit. The preflight hard-fails when the manifest disagrees
// with these, so corrupting the recovery's destination now requires editing
// two files that a reviewer diffs together.

// Threshold's Safe: the sole destination of the recovered tBTC.
// Confirm against Threshold's published Safe address before every round.
export const COLLATERAL_RECIPIENT = "0x71E47a4429d35827e0312AA13162197C23287546"

// Threshold's stBTC holder: the address the receipt tokens are pulled from.
// Less exposed than the recipient (the round amount is derived from this
// address's balance, so a wrong value fails loudly), but anchored for the
// same reason.
export const RECEIPT_PAYER = "0xd818B9f7Cb4090047D26C51e63C9CB1b5E12886a"

// The live Mezo Portal proxy.
export const PORTAL = "0xAB13B8eecf5AA2460841d75da5d5D861fD5B8A39"

// The governance account whose Timelock roles the generated manifest and
// preflight use by default. The generator must not copy this from the old
// manifest: a missing or malformed pin is exactly when regeneration is
// needed. Confirm role ownership on the live Timelock before every round.
export const PORTAL_LOGIC_OWNER = "0x98D8899c3030741925BE630C710A98B57F397C7a"

// The Portal implementation this repository's Portal.sol reconstructs, and
// its runtime bytecode hash, as recorded in UPSTREAM.md. This is the review
// anchor for the provenance gate: without it the gate compares the compiled
// artifact against a hash the generator itself writes from whatever is live,
// so an implementation change would silently re-anchor the whole artifact.
//
// Moving these is a deliberate, reviewed act: it means the recovery is being
// re-based onto a different Portal implementation, which invalidates the
// storage-layout review and requires re-auditing the mirror in
// PortalStbtcRecovery.sol.
export const ORIGINAL_IMPLEMENTATION =
  "0xb3696cdDDEaa764FEF98Dc109ECe3dEfABaB64d8"
export const IMPLEMENTATION_RUNTIME_HASH =
  "0x45d9f7bc2be7231b786206cf8c08716af1938f75363d4ec7ab1f3ee7bccb0ba7"

// Reviewed protocol identities used by the external-stBTC execution gate.
// These are deliberately address AND runtime-hash pins: an address match on
// its own is not enough to exempt a non-ERC20 destination from the default
// fail-closed share-balance check.
export const CURVE_ROUTER_V1_1 = "0x16C6521Dff6baB339122a0FE25a9116693265353"
export const CURVE_ROUTER_V1_1_RUNTIME_HASH =
  "0xf041e5b17dc8b2c417a9561eb265145e442ab25b789d9bd3527c6b68a840577b"

export const UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
export const UNISWAP_V3_FACTORY_RUNTIME_HASH =
  "0x4d7b8525cd5d14343fa67a732fba5b24cddba11620ca88392f4ec6c52f91fd69"
export const UNISWAP_V3_POSITION_MANAGER =
  "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"
export const UNISWAP_V3_POSITION_MANAGER_RUNTIME_HASH =
  "0x692e658b31cbe3407682854806658d315d61a58c7e4933a2f91d383dc00736c6"

// The only Uniswap V3 pool reached directly by a selected depositor in the
// reviewed history: canonical tBTC/stBTC at the 1% fee tier.
export const UNISWAP_V3_TBTC_STBTC_POOL =
  "0xE16eA0a2715626ECe13e63f019685193Bd0e0579"
export const UNISWAP_V3_TBTC_STBTC_POOL_RUNTIME_HASH =
  "0x7ad26176c6e61f40105287a85e123a2e6221a929ed63d6109d85e99a237fdc5f"
export const UNISWAP_V3_TBTC_STBTC_POOL_FEE = 10000
