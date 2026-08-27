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

1. Pull exactly `1.091038926395006521 stBTC` from Threshold's holder address.
2. Reduce the selected deposits' stBTC debt by the same total amount.
3. Reduce those deposits' tBTC collateral one-for-one, preserving their
   Portal accounting equity and all fees accrued before settlement.
4. Burn the stBTC.
5. Transfer exactly `1.091038926395006521 tBTC` directly to Threshold's Safe,
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
- every deposit to exist, remain outside migration, and have enough receipt
  debt;
- enough collateral to cover the remaining debt and all accrued fees;
- the settlement entries to total the exact immutable recovery amount.

The pinned manifest is
[`recovery/mainnet-25849540.json`](./recovery/mainnet-25849540.json). At block
`25849540`, there were 87 active tBTC debt positions totaling
`1.939721887006317423 tBTC`. The manifest selects the largest positions first,
which reaches Threshold's amount with five full settlements and one partial
settlement. This minimizes the number of deposit records touched. Thesis/Mezo
must explicitly approve this policy before execution.

## Required participants

- Threshold must control the stBTC holder and submit one exact ERC-20 approval
  to the Portal proxy.
- Thesis/Mezo governance must deploy and verify the recovery implementation,
  then schedule and execute the two-call ProxyAdmin batch through its timelock.
- The tBTC recipient is Threshold's existing Safe.

No OTC counterparty is required. Under the currently observed contracts, Acre
does not need to take a separate transaction: the Portal is already an
authorized stBTC debtor and calls `burnReceipt` itself. Acre/Thesis review is
still prudent in case operational controls or a newer canonical implementation
are not represented by this public reconstruction.

## Review and execution runbook

1. Thesis rebases this feature commit onto the exact canonical commit backing
   the live implementation. Confirm that the reconstructed `Portal.sol` still
   compiles to the live runtime hash recorded in [UPSTREAM.md](./UPSTREAM.md).
2. Review/audit `PortalStbtcRecovery.sol`, the six settlement entries, and the
   one-for-one accounting policy.
3. Run the unit, upgrade-layout, and pinned mainnet-fork tests.
4. Run the preflight against a current archive RPC. It intentionally aborts if
   the implementation, proxy administration, token configuration, selected
   deposit state, or runtime hash differs from the reviewed manifest.
5. Deploy and verify `PortalStbtcRecovery` using the constructor arguments
   printed by the preflight.
6. Rerun the preflight with `RECOVERY_IMPLEMENTATION` set. It reads back every
   immutable and prints the exact Threshold approval plus Timelock schedule and
   execute calldata.
7. Threshold approves the Portal—not Thesis or the recovery implementation—for
   exactly the recovery amount.
8. Mezo governance schedules the printed two-call batch, waits the configured
   delay, reruns the preflight, and executes it.
9. Verify the completion event, Threshold Safe tBTC increase, stBTC burn, debt
   and collateral changes, and restoration of implementation
   `0xb3696cdDDEaa764FEF98Dc109ECe3dEfABaB64d8`.

Example commands, using Node 18:

```bash
npm ci
npm run build
npm run test:recovery

MAINNET_RPC_URL=https://your-archive-rpc.example \
  npm run test:recovery:fork

MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_BLOCK=25849540 \
  npm run preflight:recovery

MAINNET_RPC_URL=https://your-archive-rpc.example \
RECOVERY_IMPLEMENTATION=0xDeployedRecoveryImplementation \
  npm run preflight:recovery
```

## Status and limitations

- The live Portal source reconstruction, storage layout, local atomic batch,
  and failure rollback are tested.
- The mainnet manifest is pinned to block `25849540` at
  `2026-08-27T22:25:47Z`; it is not perpetual authorization. Current-state
  preflight is mandatory immediately before governance action.
- This repository originates from a public npm snapshot and retains an old
  dependency tree with known audit warnings. It is an isolated recovery review
  artifact, not a recommendation to redeploy the whole package.
- No mainnet deployment, approval, governance proposal, or token movement has
  been performed by this repository.
