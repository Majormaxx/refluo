# ADR 0002: Fee hook ships from day one, as mutable storage with a hard ceiling

Status: accepted. Date: 2026-07.

## Decision

`RiskEngine` (`contracts/risk-engine`) owns a `fee_bps: u32` value with these
properties, implemented from the earliest scaffold:

1. **Storage, not a constant.** `fee_bps` lives in instance storage behind
   `set_fee_bps()`, never compiled into the WASM as a `const`. Raising it
   later is a state write, not a redeploy.
2. **Global scope.** One value read by every vault's RiskEngine instance,
   not snapshotted per-vault at creation. A per-vault-locked design would
   protect existing customers from a change but would also mean fees could
   only ever apply to new vaults, defeating the point of the hook.
3. **Hardcoded ceiling.** `MAX_FEE_BPS = 2000` (20%) is an actual immutable
   Rust constant, checked in `set_fee_bps()`, unchangeable by any admin or
   timelock action. This is a number a customer can verify on-chain before
   funding a vault, not a promise.
4. **Ships initialized to 0.** The scaffold enforces the ceiling but does
   not yet gate the setter behind the timelock contract — that wiring lands
   once `contracts/timelock` is fully built out and integrated.

## Why

A Soroban contract can't gain a new storage field after it's deployed
without a migration, and asking a customer to move funds into a fresh
contract instance just so a fee can be turned on later is not a
conversation worth having with someone trusting you with a treasury.
Yearn and DeFindex both solve this the same way: bake the fee field into
the vault at construction, set it to whatever value makes sense (including
zero) on day one, and never need a migration to change it later.

Full business-model rationale (why a fee at all, what it's for, sequencing
against other revenue) is tracked internally, not committed to this repo.
This ADR only documents the mechanism, which is already public once
`contracts/risk-engine` ships — the ceiling and the storage design are
visible in the contract source and on-chain, so there's nothing to protect
by keeping this ADR out of the repo.

## Consequences

- Once the timelock is wired in, `set_fee_bps()` must move off the exempt
  list — raising a fee is risk-increasing to the customer and gets the 24h
  delay + propose event, not the fast path pause/resume gets.
- Any future contract touching fee logic (e.g. a fee-share mint on harvest)
  reads `fee_bps` from RiskEngine rather than defining its own fee state.
