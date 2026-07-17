# ADR 0003: Storage class map and the epoch-counter fail-closed rule

Status: accepted. Date: 2026-07.

## Decision

| Data | Storage class | Reason |
|---|---|---|
| Vault balances, positions, venue allowlists, oracle configs, policy state | Persistent | Loss is a fund-loss vector; auto-restore is the safety net, not the plan |
| Contract admin/config singleton | Instance | Small, tied to contract lifetime |
| Recall rate-limit counters, epoch spend counters | Temporary, TTL ≥ 4× epoch length | Recreatable, cheap to rent — but see the fail-closed rule below |
| Historical burn observations | Off-chain (keeper DB) | No reason to pay rent on analytics data |

**Epoch-counter fail-closed rule**: epoch keys are derived from ledger time
so an expired counter reconstructs as zero only for a *fresh* epoch index —
never mid-epoch. A `last_write_epoch` value is stored in **persistent**
storage alongside the temporary counter; if `last_write_epoch` equals the
current epoch but the temporary key is missing (expired early or evicted),
the read reverts as `BadState` rather than silently treating it as zero
spend. The bug this closes: a temporary counter that expires or gets
evicted mid-epoch would otherwise read back as zero, silently resetting
whatever cap it was tracking back to unspent for the rest of that epoch.
One extra persistent slot per (account, rule_id) is a cheap price for
making that failure mode structurally impossible instead of hoping nobody
finds it.

Nothing in the recall path is ever allowed to archive. Weekly keeper TTL
sweep over instance storage and hot persistent keys.

## Why

Soroban's archived persistent/instance entries auto-restore when RPC
simulation detects the access and populates the restore list — but restored
access costs more (disk-tier fees) and adds latency, which is unacceptable
in the recall path specifically. Temporary entries are permanently deleted
at TTL zero with no restore path at all, which is fine for a recreatable
counter and catastrophic for anything else — hence the persistent/temporary
split above is not a rent-optimization choice, it's a fund-safety one.

## Consequences

- Any new contract storage decision defaults to this table. A PR adding
  fund-relevant state to Temporary storage should be rejected outright.
- The epoch fail-closed pattern (persistent `last_write_epoch` sentinel)
  is the same shape in every policy that has an epoch cap (`policy-venue`,
  `policy-session`), but implemented separately per contract rather than
  as a shared helper — the two configs' field shapes differ enough that a
  generic helper would cost more clarity than the ~15 duplicated lines
  cost maintenance. Revisit if a third policy needs the same pattern.
