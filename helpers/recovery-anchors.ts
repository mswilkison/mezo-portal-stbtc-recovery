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
