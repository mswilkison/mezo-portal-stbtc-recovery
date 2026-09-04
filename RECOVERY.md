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
test independently enforce the no-stranding property. The recovery contract
enforces it atomically too: inside the execution transaction it reads each
selected owner's live stBTC balance once and their live debt across the
reviewed active-deposit list carried in the calldata, and caps that owner's
total settlement at debt minus balance. A receipt-token transfer to a
selected owner after the preflight is therefore first absorbed by the
owner's unselected debt and at worst reduces the recovered amount once per
owner — never multiplied per deposit — and cannot leave the recipient
holding unredeemable stBTC **in the wallet the guard can see**.

That last qualifier is a real limit, not boilerplate. The on-chain guard can
only price `balanceOf(depositor)`. stBTC the same party holds indirectly —
in the Curve stBTC/tBTC pool, a vault, or a second address — is invisible to
it, and so is invisible to the selection policy, which uses the same
measure. This is precisely the case that matters: Threshold's own stranded
balance came from exiting that Curve pool, so a selected depositor with a
pool position is exactly the party this recovery could strand. Screening for
it is therefore a mandatory review step, not something the contract can
enforce. `npm run check:external-stbtc` replays the stBTC transfer history of
each owner with a positive live settlement upper bound, reports where their
receipt tokens went, and fails closed on a detected claim. An unreadable
claim balance remains explicitly UNRESOLVED rather than being reset to zero
and always blocks, even when the
manual-review attestation is present. The reviewed Curve Router v1.1 and
Uniswap V3 tBTC/stBTC destinations are handled by narrow protocol adapters:
the former verifies its exact runtime/version and reconciles each stBTC input
transaction to a tBTC output returned to the same depositor, while the latter
verifies the canonical factory, pool, and position-manager identities and
re-reads every currently wallet-owned stBTC position NFT. It also enumerates
every direct core `Mint` credited to each depositor in any pool (the query
carries no pool address), authenticates emitters against the canonical
factory's stBTC `PoolCreated` history, then verifies each pool's identity and
registration at the pinned block and re-reads every direct core position
range. Uniswap V3 does not require liquidity to be represented by an NFT and
a third party can mint a core range directly to a depositor in any stBTC
pool. Any nonzero position
liquidity or uncollected amount blocks. Unauthenticated Mint emitters are
ignored by this adapter; unrelated logs do not establish an stBTC claim.
Unreadable authenticated pools remain UNRESOLVED. Factory discovery covers
both token orderings from genesis, including pools created before stBTC
deployment. NFT transfers in both directions and direct Mint events also
start at genesis: a one-sided position can predate the token and later hold
stBTC. All these queries share the incremental history cache. The persistent
one-wei balances at those two contracts are therefore
resolved by protocol evidence, never by a generic dust exception; code drift,
receipt mismatch, or an unreadable position remains UNRESOLVED.

That automated list is not exhaustive: an owner can receive LP tokens without
sending stBTC, stake the LP in a gauge/vault, or use another controlled
address. The command therefore never treats an automated-only result as
CLEAN; it passes only with the exact manual-review confirmation documented
below. If a depositor's complete ownership and protocol positions cannot be
established, do not attest — reduce their settlement by the externally held
amount or exclude them.

The selection is reproducible:
`npm run generate:recovery-manifest` rebuilds the manifest from chain state
at any block, so reviewers can regenerate and diff it instead of trusting
the committed file; the generator reserves each selected owner's own
holdings out of their selectable debt and refuses to emit a manifest whose
event scan does not reconcile with the Portal's own `totalMinted`
bookkeeping. It stores the resolved block's exact hash and revalidates that
hash immediately before writing. Every workflow that trusts the settlement
selection resolves the stored height before use and rejects the manifest if
its recorded hash is no longer canonical. Long-running RPC workflows repeat
that check before accepting their result. A replacement block requires a newly
generated and reviewed manifest even when selected fields happen to match.
The generator takes every non-chain-derived address, including the default
governance role-holder, from `helpers/recovery-anchors.ts`; it does not load
the old manifest, so a missing or malformed pin cannot prevent regeneration.

The pinned manifest is
[`recovery/mainnet-25850299.json`](./recovery/mainnet-25850299.json)
(referenced everywhere through `helpers/recovery-manifest.ts`). It binds the
selection to block `25850299`, hash
`0x3ce97866ebf2413f71148da785efa3746e1208623d950e8910afa9e9cfe31ad5`.
At that snapshot there were 87 active tBTC debt positions totaling
`1.939721887006317423 tBTC`. The policy reaches Threshold's amount with ten
settlements across six depositors — nine full and one partial — and excludes
eight depositors that currently hold stBTC. Thesis/Mezo must explicitly
approve this policy before execution.

## Drift tolerance instead of a third-party veto

The reviewed calldata is fixed by the timelock, and the settlement entries
may not total more than the immutable maximum recovery amount. Within that
reviewed selection, execution tolerates ordinary third-party activity
between review and execution. A deposit that was repaid, withdrawn,
migrated, or became under-collateralized after the manifest was pinned is
skipped (with a `ReceiptDebtSettlementSkipped` event), a partially repaid
deposit is settled up to its remaining debt, and an owner who acquired
stBTC has their total settlement capped once, per owner, by the atomic
stranding guard described above. The amount pulled from Threshold, burned,
and released always equals the debt actually settled and never exceeds the
approved amount.

The settlement emits `ReceiptDebtSettled` and `StbtcRecoveryCompleted`, not
the Portal's canonical `ReceiptRepaid` and `Withdrawn`. That is deliberate:
the tBTC goes to Threshold's Safe rather than the depositor, so `Withdrawn`
would be factually wrong, and no depositor repaid anything, so
`ReceiptRepaid` would misattribute the repayment. The consequence is that
any consumer deriving Portal balances from event handlers — a subgraph, a
dapp deposit view, reconciliation monitoring — will not see these
reductions and will desync for the settled deposits until it re-reads live
state. Notify those consumers before execution; the recovery's event topics
are not part of any published Portal ABI, because the temporary
implementation is installed and removed within one transaction.

Without this, any depositor named in the manifest could veto the whole
recovery — a 1 wei repayment during the timelock delay would revert the
batch, forcing a new manifest, review, schedule, and delay each time. If
settlements drift, the recovery completes for the settled portion; the
batch reverts only if nothing at all can be settled, and that reverted
operation stays scheduled and retryable. Blocking the batch through the
stranding guard is not an economical veto: it requires pushing every
selected owner's stBTC holdings up to their entire active debt — roughly
the full recovery amount, donated irrevocably to those depositors, who are
left able to repay their own debt in full. Any residual stBTC and
allowance stay with Threshold for a follow-up round, which reuses the
already-deployed implementation with fresh calldata (the immutable amount
is an upper bound, so no redeploy, re-verification, or new constructor
arguments are needed).

## Fixed safety boundaries

The recovery implementation stores no new proxy state. Constructor immutables
bind it to:

- the live Portal proxy and ProxyAdmin;
- the live tBTC and stBTC contracts;
- Threshold's stBTC payer and tBTC recipient;
- the maximum receipt debt any single `recoverTbtc` call may request
  (`EXPECTED_MAX_RECOVERY_AMOUNT`). This is a per-call **upper bound**, not a
  lifetime total: the deployed implementation can be re-invoked with fresh
  reviewed calldata, which is what makes a residual round cheap. What pins a
  given round to specific deposits and amounts is the timelock's commitment
  to the exact calldata, not the immutable.

The call additionally requires:

- `msg.sender` to be the Portal ProxyAdmin, which is owned by the Mezo
  Timelock;
- the Portal's configured tokens to match the immutable addresses;
- tBTC and stBTC to have equal decimals;
- the requested settlement entries to total at most the immutable maximum
  recovery amount (the timelock already commits their exact contents, so
  only reviewed calldata can execute);
- every settlement entry's depositor to carry a reviewed active-deposit
  context (unique per depositor, ids strictly ascending) for the stranding
  guard;
- every settled deposit to exist, remain outside migration, and keep enough
  collateral for its remaining debt and accrued fees (deposits that no longer
  qualify are skipped, never over-settled);
- every selected depositor to retain receipt debt covering their live stBTC
  balance — capped once per owner across all their entries — enforced during
  `recoverTbtc` itself;
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
state and prints calldata while Threshold's approval is still outstanding;
at any block other than the manifest snapshot it reports selected-deposit
drift and projects the clamped execution outcome instead of aborting,
because the contract tolerates drift by design — a hard failure there would
hand third parties a process-level veto the contract itself does not have.
`RECOVERY_STAGE=execute` is the mandatory rerun immediately before
`executeBatch`: it refuses `RECOVERY_BLOCK`, completes the external-history
scan before reading any mutable execution gate, and then validates those
gates at a fresh latest block. It hard-fails unless the exact allowance is in
place, the operation is ready, and the projected settlement is nonzero. A
materially reduced projection (a residual greater than the manifest's
`strandingDustWei` multiplied by the selected-owner count) requires the same
explicit `RECOVERY_ACCEPT_REDUCED_RECOVERY=1` acknowledgment at both stages —
at the execute stage an unaccepted reduction or all-zero projection prints
`preflightPassed: false` with the verified cancellation calldata before
exiting nonzero — so drift discovered after scheduling cannot silently
execute a smaller round than governance signed off on. Structural checks —
implementation, proxy administration, tokens, runtime hash, and the reviewed
anchors — are hard failures at every stage.

Token funding and receipt-debt consistency are checked against a live
settlement upper bound: permanently unavailable deposits are excluded and
each remaining request is clamped to that deposit's live debt. The bound
deliberately ignores fee-boundary and owner-capacity skips because those can
make the projection lower than what the contract ultimately settles. Under
the verified Portal implementation, debt cannot be re-minted into the
reviewed deposit ids, so the bound is sufficient for the tBTC transfer, stBTC
pull and burn, and both debt reductions. Because it falls with ordinary
repayments and withdrawals, those actions cannot veto a valid partial round
by leaving funding checks pinned to the stale requested total.

Timelock role checks are a weaker assurance than the rest, and the runbook
should not be read as claiming otherwise: the preflight is read-only and has
no signer, so by default it can only report the roles held by the
manifest-pinned governance account while the timelock has several role
holders. Set `RECOVERY_EXPECTED_SENDER` to the account that will actually
submit the transaction so the roles are verified for it; without it the run
prints an explicit warning. `CANCELLER_ROLE` is a hard failure at the
execute stage, because losing the documented abort path matters exactly when
a scheduled batch must not execute.

The manifest's required `snapshotBlockHash` binds its selection evidence to
the exact block used by the generator. Before trusting that selection, the
preflight, standalone external-position scan, and fork test resolve
`snapshotBlock` and require the canonical hash to match, even when the
operational preflight or scan runs at a later block. Long-running operator
workflows recheck the manifest snapshot again before reporting success.

Prepare, manifest-generation, and explicit-block standalone scans each resolve
one operational block and pin every snapshot storage read, code read, and
contract call to its hash. Historical log ranges and the stBTC
deployment-boundary check require numeric heights, so each workflow re-fetches
the endpoint after all dependent reads and requires its canonical hash to
match.

Execute adds a freshness phase around its longer external-position work. Its
first pass verifies the Portal identity and reads selected deposits at the
candidate hash. Only owners with a positive live settlement upper bound enter
the external gate: fully repaid, withdrawn, or migrating selected deposits
cannot settle, while temporary fee or wallet-capacity skips do not remove an
owner. The standalone check applies the same scope at its evaluated block.
It scans the token's raw Transfer history from stBTC deployment, and Uniswap
NFT ownership, direct Mint, and canonical pool creation histories from
genesis through an initial head. If that scan outlives
the head, the preflight keeps the raw history and reruns the complete external
evaluation, including the live owner scope, at the newer hash while querying
only each missing numeric tail.
It accepts at most five passes and only when the evaluated block is still
canonical and the head is at most one block past it immediately after a pass;
a reorged committed boundary, head regression/replacement, incomplete query,
or failure to converge is blocking. It then performs the remaining core
checks, including Portal configuration, roles, balances, allowance, pause state,
deposits, fees, deployed recovery bytecode, and timelock operation at that
same block hash. Immediately before serialization it revalidates the manifest
snapshot and operational hash again and requires the head to be at most three
blocks (`MAX_EXECUTE_HEAD_LAG_BLOCKS`, about 36 seconds) past the operational
block. Freshness is therefore bounded staleness, not exact-head equality:
exact equality certified nothing more (state can change after the last RPC
read either way) while failing nondeterministically against a 12-second block
time, and every retry re-scans history from each query's starting block.
A pass reports
`verifiedAt.blockHashRevalidated: true`,
`verifiedAt.latestHeadRevalidated: true`, `verifiedAt.headLagBlocks`, and the
external review's `historyScan` boundaries/pass count. A head that advances
past the budget during the final live checks produces
`preflightPassed: false` instead of certifying old state.

These checks are a fresh point-in-time observation, not a transaction lock. A
new block or transaction can still land after the final RPC response; the
contract rechecks its own settlement guards atomically, but it cannot enforce
the off-chain external-position review or freeze governance/token
configuration. Submit immediately after a green execute preflight and rerun it
after any operational delay. Because a numeric range response also cannot
prove that an RPC never served a transient alternate fork, the
independent-provider comparison in step 4 remains mandatory.

1. Thesis rebases this feature commit onto the exact canonical commit backing
   the live implementation. `npm run test:recovery` includes a provenance
   test asserting the reconstructed `Portal.sol` compiles byte-for-byte to
   the live runtime hash recorded in [UPSTREAM.md](./UPSTREAM.md) (this
   requires the `evmVersion: "paris"` compiler setting pinned in
   `hardhat.config.ts`). That hash, the Portal proxy, the implementation
   address, governance role-holder, and both Threshold counterparties are
   duplicated as reviewed constants in
   [`helpers/recovery-anchors.ts`](./helpers/recovery-anchors.ts); the
   preflight hard-fails if the manifest disagrees with them. Confirm
   `COLLATERAL_RECIPIENT` there against a source outside this repository —
   it is the destination of every released tBTC and nothing on chain
   anchors it, so a wrong-but-valid address would otherwise be carried
   forward by the generator and "verified" against itself.
2. Review/audit `PortalStbtcRecovery.sol`, the settlement entries, the
   stranding exclusions, and the one-for-one accounting policy. Optionally
   regenerate the manifest (`npm run generate:recovery-manifest`) and diff it
   against the committed one, including its exact snapshot block hash.
3. Run the unit, upgrade-layout, and pinned mainnet-fork tests
   (`npm run test:recovery` covers the first two — the storage-layout test
   is included there and is deliberately skipped by `npm run test:upgrades`,
   which runs against a remote network that cannot sign local deployments).
4. Screen the selected depositors for externally held stBTC. First manually
   verify every other address each depositor controls and every LP, share,
   gauge, vault, or locked position that can return stBTC — including tokens
   received without a direct stBTC transfer. Then run:

   ```sh
   CHECK_BLOCK=<recent finalized block> \
   MAINNET_RPC_URL=<archive rpc> \
   RECOVERY_EXTERNAL_STBTC_REVIEW=I_CONFIRM_NO_EXTERNAL_STBTC_CLAIMS \
   npm run check:external-stbtc
   ```

   This is the review the on-chain guard structurally cannot perform. The
   confirmation is an operator attestation, not an automated proof; do not
   persist it in `.env`. The scan reconciles each selected wallet's complete
   stBTC Transfer history against its pinned balance, reads archive logs in
   adaptive chunks, and recognizes the reviewed Portal sink only while its
   proxy points to the pinned implementation. Before reporting PASSED it
   re-fetches `CHECK_BLOCK` and rejects the report if the initially resolved
   hash is no longer canonical when the scan completes. Its typed Portal,
   Curve, and Uniswap checks must report no claim or unresolved state, and the
   command as a whole must report PASSED before the manifest is approved. If
   ownership or venue coverage is uncertain, exclude or reduce that depositor
   instead. A single RPC can still omit a matching inbound/outbound pair
   without violating the net reconciliation, so run the same pinned
   `CHECK_BLOCK` through a second, independently operated archive provider and
   compare the block hash and complete report before approval.

5. Run the preflight against a current archive RPC. It intentionally aborts
   if the implementation, proxy administration, token configuration, timelock
   roles, or runtime hash differs from the reviewed manifest. It re-reads
   every active deposit listed for each selected owner, computes current
   debt from those live records instead of trusting the snapshot total, and
   projects the clamped settlement the contract would produce. At the
   prepare stage a materially reduced projection (a residual greater than
   `strandingDustWei * selectedOwnerCount`) aborts with instructions to
   regenerate the manifest, unless governance explicitly accepts recovering
   less this round with `RECOVERY_ACCEPT_REDUCED_RECOVERY=1`.
6. Deploy and verify `PortalStbtcRecovery` using the constructor arguments
   printed by the preflight.
7. Rerun the preflight with `RECOVERY_IMPLEMENTATION` set. It verifies the
   deployed runtime bytecode byte-for-byte against the local artifact. Before
   masking immutable ranges for the comparison, it verifies every occurrence
   against the expected constructor value; getter readbacks alone are not
   sufficient. It then reports the timelock operation's state and prints the
   exact Threshold approval plus Timelock schedule, execute, and cancel
   calldata. Record `governanceBatch.salt` and `governanceBatch.operationId`
   from this output: the execute-stage rerun in step 10 must be given that
   salt, and the cancel path needs that id.
8. Mezo governance schedules the printed two-call batch. From this point
   until execution or cancellation, no other governance action may touch the
   Portal, its ProxyAdmin, or the timelock's Portal-related roles: the
   batch's second call restores the implementation address captured in the
   reviewed manifest, so an intervening upgrade would be silently reverted by
   the recovery batch. No on-chain check can enforce this — a transparent
   proxy's implementation slot is unreadable from other contracts — so the
   freeze is process-enforced: the execute-stage preflight re-verifies the
   live implementation immediately before `executeBatch`, and executors must
   not skip or race it. If anything must change, cancel first (calldata is
   printed in step 7), then re-pin. Commit the manifest before scheduling and
   do not edit it afterwards: the operation id commits to the manifest's JSON
   content, so a value change produces a different id (formatting-only
   changes do not).
9. After the configured delay elapses, Threshold approves the Portal—not
   Thesis or the recovery implementation—for exactly the recovery amount.
   Approving before or during the delay would leave a standing allowance to
   an upgradeable proxy for longer than necessary.
10. Immediately before `executeBatch`, governance repeats the manual review
    from step 4 and reruns the preflight with `RECOVERY_STAGE=execute`,
    `RECOVERY_IMPLEMENTATION`, `RECOVERY_SALT=<the salt recorded in step 7>`,
    and `RECOVERY_EXTERNAL_STBTC_REVIEW=I_CONFIRM_NO_EXTERNAL_STBTC_CLAIMS`.
    `RECOVERY_IMPLEMENTATION` is validated before the archive scan starts, so
    a missing value fails in seconds rather than after minutes of scanning.
    The execute preflight first performs the full automated external-position
    scan. If new blocks arrive, it extends the cached raw history only across
    the missing tails and reruns all live external reads until that evaluated
    block is the head or at most one block behind it. It then runs every
    Portal, token, recovery implementation, projection, role, allowance,
    pause-state, and operation-state check at that same hash and requires the
    head to be at most three blocks past it just before output. A failed
    convergence, final freshness/canonicality check, detected claim,
    unreadable relevant `balanceOf`, protocol identity/transaction mismatch,
    active or uncollected Uniswap V3 NFT/core position, missing manual
    confirmation, stale allowance, paused stBTC, unready operation,
    insufficient funding or receipt debt, unverified deployed implementation,
    zero projection, or unaccepted material reduction prints the verified
    cancellation calldata and exits nonzero. Two exceptions are deliberate: an
    operation id that is not scheduled under the computed salt gets no cancel
    calldata (cancelling it would revert while the real operation stayed
    pending — supply the recorded salt instead), and an implementation that
    fails verification gets no schedule/execute calldata. Only submit the
    batch immediately after this run reports `preflightPassed: true`; rerun
    after any delay. The final head comparison narrows but cannot eliminate
    the transaction-submission race described above.
11. Verify the `StbtcRecoveryCompleted` event and any
    `ReceiptDebtSettlementSkipped` events, the Threshold Safe tBTC increase,
    the stBTC burn, debt and collateral changes, and restoration of
    implementation `0xb3696cdDDEaa764FEF98Dc109ECe3dEfABaB64d8`. If any
    settlement was skipped or clamped, the recovered amount is the settled
    total. Threshold then revokes the residual allowance with
    `approve(portal, 0)` and handles the remainder in a follow-up round: a
    fresh manifest and schedule against the same deployed implementation
    (its immutable amount is an upper bound), needing no redeploy. The
    residual round's preflight passes the original deployment's amount as
    `RECOVERY_DEPLOYED_MAX_WEI`, which anchors the byte-for-byte immutable
    verification externally instead of trusting the deployed getter.

If the attempt is abandoned at any point after scheduling: cancel the
timelock operation (step 7 prints the calldata — operations never expire on
their own, and a stale batch would re-install the old implementation if
executed after an unrelated Portal upgrade), and revoke any approval already
granted. The default operation salt commits to the manifest's JSON content
(whitespace- and line-ending-insensitive), so a corrected manifest
automatically produces a fresh operation id that cannot collide with the
cancelled one, while a prettier reflow does not move the id away from the
scheduled batch. `RECOVERY_SALT` accepts either a 32-byte hex value (used
verbatim) or any other string (hashed with `ethers.id`); pass the salt printed
at scheduling to every later run, and if a run ever reports the operation as
`unset`, take the scheduled id from the timelock's `CallScheduled` event
rather than trusting a recomputed one.

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

# Immediately before executeBatch (RECOVERY_SALT = governanceBatch.salt
# printed by the run whose scheduleTransaction was submitted):
MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_IMPLEMENTATION=0xDeployedRecoveryImplementation \
RECOVERY_SALT=0xSaltPrintedAtScheduling \
RECOVERY_STAGE=execute \
RECOVERY_EXTERNAL_STBTC_REVIEW=I_CONFIRM_NO_EXTERNAL_STBTC_CLAIMS \
  npm run preflight:recovery

# To re-pin the manifest at a new block:
MAINNET_RPC_URL=https://your-archive-rpc.example \
  npm run generate:recovery-manifest
```

## Status and limitations

- The live Portal source reconstruction (verified by the compiled-hash
  provenance test), storage layout, local atomic batch, drift handling, and
  failure rollback are tested.
- The mainnet manifest is pinned to block `25850299`, hash
  `0x3ce97866ebf2413f71148da785efa3746e1208623d950e8910afa9e9cfe31ad5`,
  at `2026-08-28T00:57:59Z`; it is not perpetual authorization. Current-state
  preflight is mandatory immediately before governance action, and the
  execute-stage preflight is mandatory immediately before `executeBatch`.
- Execute-stage freshness is point-in-time. The preflight catches changes that
  occur during its archive scan and final live checks, but state can change
  after its last `latest` read and before transaction inclusion. Submit
  immediately; the contract's atomic guards remain authoritative for the
  on-chain settlement state.
- The stranding dust threshold (`1e12 wei`) and the balance-aware selection
  policy are governance-visible parameters recorded in the manifest;
  approving the manifest approves the policy. The contract's per-owner live
  balance guard remains authoritative if holdings change after that
  approval.
- This repository originates from a public npm snapshot and retains an old
  dependency tree with known audit warnings. It is an isolated recovery
  review artifact, not a recommendation to redeploy the whole package.
- No mainnet deployment, approval, governance proposal, or token movement has
  been performed by this repository.
