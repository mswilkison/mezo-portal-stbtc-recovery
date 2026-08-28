# Threshold stBTC recovery proposal

## The issue, in simple terms

Threshold's address
`0xd818B9f7Cb4090047D26C51e63C9CB1b5E12886a` holds exactly
`1.091038926395006521 stBTC`.

The Bitcoin is not missing, and the wallet is not locked. The problem is that
the Portal's normal repayment path ties each stBTC repayment to the owner of a
specific deposit. Threshold's original deposit was already repaid and
withdrawn. Its remaining stBTC came from exiting the imbalanced stBTC/tBTC
Curve pool, so Threshold now owns valid, fungible stBTC but has no open Portal
deposit against which it can burn that stBTC and withdraw tBTC.

Meanwhile, the Portal still holds tBTC and other deposits still owe more than
enough stBTC. The missing feature is a way to match stBTC held by one address
against those existing receipt debts without pretending that Threshold owns
the other deposit records.

## Proposed recovery—no OTC and no sale

Mezo governance temporarily installs `PortalStbtcRecovery`, which performs one
fixed settlement:

1. Pull up to `1.091038926395006521 stBTC` from Threshold's holder address —
   exactly the receipt debt actually settled in step 2.
2. Reduce the selected deposits' stBTC debt by the same total amount.
3. Reduce those deposits' tBTC collateral one-for-one, preserving their
   Portal accounting equity and all fees accrued before settlement.
4. Burn the stBTC.
5. Transfer the same settled amount of tBTC directly to Threshold's Safe,
   `0x71E47a4429d35827e0312AA13162197C23287546`.

No token is sold, swapped, priced, or transferred to Thesis. This is protocol
accounting netting: an equal nominal amount of receipt debt and its tBTC
collateral are extinguished together.

The current Portal runtime is only 136 bytes below Ethereum's EIP-170 contract
size limit. A permanent recovery function cannot be added without a broader
Portal refactor. The proposal therefore uses a small temporary implementation.
The Timelock executes both ProxyAdmin calls in one atomic batch:

```text
Portal current implementation
        │
        ├─ upgradeAndCall(recovery, recoverTbtc(manifest))
        │       ├─ verify fixed Portal/Admin/tBTC/stBTC/holder/recipient/amount
        │       ├─ update debt, collateral, and fee accounting
        │       ├─ pull and burn Threshold's stBTC
        │       └─ send the same amount of tBTC to Threshold's Safe
        │
        └─ upgradeAndCall(original implementation, 0x)
```

If any check, transfer, burn, or restoration fails, the entire timelock
transaction reverts—including the first upgrade. There is no externally
observable interval in which the temporary implementation remains installed.

## Settlement selection must not strand anyone else

Settling a deposit burns down debt its owner could otherwise repay
themselves. stBTC has no general redemption path: the only way to turn stBTC
back into Portal collateral is repaying the receipt debt of a deposit you
own. A depositor left holding more stBTC than their remaining receipt debt
would hold unredeemable stBTC — the exact stranded position this recovery
exists to cure for Threshold, recreated for a non-consenting third party.
This is not hypothetical: several Portal depositors currently hold stBTC
(some bought below par to repay their own debt), including one holding
`0.3876 stBTC` against `0.3845 stBTC` of debt across four deposits.

The manifest is therefore generated with a balance-aware policy: largest
active tBTC receipt debts first, restricted to depositors holding no more
than a dust threshold (`1e12 wei`) of stBTC, with the final deposit settled
partially. Depositors excluded by the policy are recorded in the manifest
under `strandingExclusions` for review, and both the preflight and the fork
test independently enforce the no-stranding property. The selection is
reproducible: `npm run generate:recovery-manifest` rebuilds the manifest from
chain state at any block, so reviewers can regenerate and diff it instead of
trusting the committed file.

The pinned manifest is
[`recovery/mainnet-25850299.json`](./recovery/mainnet-25850299.json)
(referenced everywhere through `helpers/recovery-manifest.ts`). At block
`25850299`, there were 87 active tBTC debt positions totaling
`1.939721887006317423 tBTC`. The policy reaches Threshold's amount with ten
settlements across six depositors — nine full and one partial — and excludes
eight depositors that currently hold stBTC. Thesis/Mezo must explicitly
approve this policy before execution.

## Drift tolerance instead of a third-party veto

The reviewed calldata is fixed: the settlement entries must total exactly the
immutable recovery amount, or the batch reverts. Within that reviewed
selection, execution tolerates ordinary third-party activity between review
and execution. A deposit that was repaid, withdrawn, migrated, or became
under-collateralized after the manifest was pinned is skipped (with a
`ReceiptDebtSettlementSkipped` event), and a partially repaid deposit is
settled up to its remaining debt. The amount pulled from Threshold, burned,
and released always equals the debt actually settled and never exceeds the
approved amount.

Without this, any depositor named in the manifest could veto the whole
recovery — a 1 wei repayment during the timelock delay would revert the
batch, forcing a new manifest, review, schedule, and delay each time. If
settlements drift, the recovery completes for the settled portion; the batch
reverts only if nothing at all can be settled. Any residual stBTC and
allowance stay with Threshold for a follow-up round.

## Fixed safety boundaries

The recovery implementation stores no new proxy state. Constructor immutables
bind it to:

- the live Portal proxy and ProxyAdmin;
- the live tBTC and stBTC contracts;
- Threshold's stBTC payer and tBTC recipient;
- the exact recovery amount.

The call additionally requires:

- `msg.sender` to be the Portal ProxyAdmin, which is owned by the Mezo
  Timelock;
- the Portal's configured tokens to match the immutable addresses;
- tBTC and stBTC to have equal decimals;
- the requested settlement entries to total the exact immutable recovery
  amount, so the reviewed calldata cannot change;
- every settled deposit to exist, remain outside migration, and keep enough
  collateral for its remaining debt and accrued fees (deposits that no longer
  qualify are skipped, never over-settled);
- at least one settlement to actually apply.

## Required participants

- Threshold must control the stBTC holder and submit one exact ERC-20
  approval to the Portal proxy — after the timelock delay has elapsed,
  immediately before execution (see the runbook).
- Thesis/Mezo governance must deploy and verify the recovery implementation,
  then schedule and execute the two-call ProxyAdmin batch through its
  timelock.
- The tBTC recipient is Threshold's existing Safe.

No OTC counterparty is required. Under the currently observed contracts, Acre
does not need to take a separate transaction: the Portal is already an
authorized stBTC debtor and calls `burnReceipt` itself. Acre/Thesis review is
still prudent in case operational controls or a newer canonical implementation
are not represented by this public reconstruction.

## Review and execution runbook

The preflight has two stages. `RECOVERY_STAGE=prepare` (the default) verifies
state and prints calldata while Threshold's approval is still outstanding.
`RECOVERY_STAGE=execute` is the mandatory rerun immediately before
`executeBatch`: it additionally hard-fails unless the exact allowance is in
place, the operation is ready, and nothing has drifted.

1. Thesis rebases this feature commit onto the exact canonical commit backing
   the live implementation. `npm run test:recovery` includes a provenance
   test asserting the reconstructed `Portal.sol` compiles byte-for-byte to
   the live runtime hash recorded in [UPSTREAM.md](./UPSTREAM.md) (this
   requires the `evmVersion: "paris"` compiler setting pinned in
   `hardhat.config.ts`).
2. Review/audit `PortalStbtcRecovery.sol`, the settlement entries, the
   stranding exclusions, and the one-for-one accounting policy. Optionally
   regenerate the manifest (`npm run generate:recovery-manifest`) and diff it
   against the committed one.
3. Run the unit, upgrade-layout, and pinned mainnet-fork tests.
4. Run the preflight against a current archive RPC. It intentionally aborts
   if the implementation, proxy administration, token configuration, timelock
   roles, selected deposit state, or runtime hash differs from the reviewed
   manifest — or if any settlement would strand a third-party stBTC holder.
5. Deploy and verify `PortalStbtcRecovery` using the constructor arguments
   printed by the preflight.
6. Rerun the preflight with `RECOVERY_IMPLEMENTATION` set. It verifies the
   deployed runtime bytecode byte-for-byte against the local artifact (with
   immutable value ranges masked), reads back every immutable, reports the
   timelock operation's state, and prints the exact Threshold approval plus
   Timelock schedule, execute, and cancel calldata.
7. Mezo governance schedules the printed two-call batch. From this point
   until execution or cancellation, no other governance action may touch the
   Portal, its ProxyAdmin, or the timelock's Portal-related roles: the
   batch's second call restores the implementation address captured in the
   reviewed manifest, so an intervening upgrade would be silently reverted by
   the recovery batch. If anything must change, cancel first (calldata is
   printed in step 6), then re-pin.
8. After the configured delay elapses, Threshold approves the Portal—not
   Thesis or the recovery implementation—for exactly the recovery amount.
   Approving before or during the delay would leave a standing allowance to
   an upgradeable proxy for longer than necessary.
9. Governance reruns the preflight with `RECOVERY_STAGE=execute` (it now
   requires the allowance and a ready operation) and executes the batch.
10. Verify the `StbtcRecoveryCompleted` event and any
    `ReceiptDebtSettlementSkipped` events, the Threshold Safe tBTC increase,
    the stBTC burn, debt and collateral changes, and restoration of
    implementation `0xb3696cdDDEaa764FEF98Dc109ECe3dEfABaB64d8`. If any
    settlement was skipped or clamped, the recovered amount is the settled
    total; Threshold then revokes the residual allowance (`approve(portal,
0)`) and the remainder is handled in a follow-up round with a fresh
    manifest.

If the attempt is abandoned at any point after scheduling: cancel the
timelock operation (step 6 prints the calldata — operations never expire on
their own, and a stale batch would re-install the old implementation if
executed after an unrelated Portal upgrade), and revoke any approval already
granted. The default operation salt commits to the manifest file's hash, so a
corrected manifest automatically produces a fresh operation id that cannot
collide with the cancelled one. `RECOVERY_SALT` accepts either a 32-byte hex
value (used verbatim) or any other string (hashed with `ethers.id`).

Example commands, using Node 18:

```bash
npm ci
npm run build
npm run test:recovery

MAINNET_RPC_URL=https://your-archive-rpc.example \
  npm run test:recovery:fork

MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_BLOCK=25850299 \
  npm run preflight:recovery

MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_IMPLEMENTATION=0xDeployedRecoveryImplementation \
  npm run preflight:recovery

# Immediately before executeBatch:
MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_IMPLEMENTATION=0xDeployedRecoveryImplementation \
RECOVERY_STAGE=execute \
  npm run preflight:recovery

# To re-pin the manifest at a new block:
MAINNET_RPC_URL=https://your-archive-rpc.example \
  npm run generate:recovery-manifest
```

## Status and limitations

- The live Portal source reconstruction (verified by the compiled-hash
  provenance test), storage layout, local atomic batch, drift handling, and
  failure rollback are tested.
- The mainnet manifest is pinned to block `25850299` at
  `2026-08-28T00:57:59Z`; it is not perpetual authorization. Current-state
  preflight is mandatory immediately before governance action, and the
  execute-stage preflight is mandatory immediately before `executeBatch`.
- The stranding dust threshold (`1e12 wei`) and the balance-aware selection
  policy are governance-visible parameters recorded in the manifest;
  approving the manifest approves the policy.
- This repository originates from a public npm snapshot and retains an old
  dependency tree with known audit warnings. It is an isolated recovery
  review artifact, not a recommendation to redeploy the whole package.
- No mainnet deployment, approval, governance proposal, or token movement has
  been performed by this repository.
