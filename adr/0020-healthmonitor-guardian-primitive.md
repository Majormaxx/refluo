# ADR 0020: HealthMonitor guardian roster on OZ's real AccessControl primitive

Status: accepted. Date: 2026-07.

## Decision

The PRD flagged this as an open question at Phase 0 and deferred a real
decision to this phase: whether OZ ships a reusable pausable/access-control
building block for `health-monitor`'s guardians instead of a bespoke set.
Researched both real candidates in OpenZeppelin's real `stellar-contracts`
monorepo (`packages/contract-utils/src/pausable`, `packages/access/src/access_control`,
crate names `stellar-contract-utils` and `stellar-access`, both real
published crates at the same `0.7.2` version already pinned for
`stellar-accounts`, confirmed via `cargo search`).

**Adopted `stellar-access`'s `AccessControl` for the guardian roster.**
`health-monitor`'s guardian membership and admin record now live in that
crate's real, audited role-based storage (`grant_role`/`revoke_role`/
`has_role`/`set_admin`/`get_admin`) instead of a hand-rolled
`Vec<Address>` and a duplicate `DataKey::Admin`. Two new real methods,
`add_guardian`/`remove_guardian`, grant a genuine capability the old
design never had: adding or removing one guardian without replacing the
whole roster (the old `init_guardians` could only ever overwrite the
entire `Vec` at once). `guardians()` now reconstructs the roster from
role enumeration instead of reading a single stored `Vec`.

**Did not adopt `stellar-contract-utils`'s `Pausable` module** for the
pause state machine itself. Real reasons, not a coin flip:

- OZ's `Pausable` is an unauthenticated boolean flag with two events,
  `Paused {}` / `Unpaused {}` — its own doc comment states plainly that
  "the base implementation... intentionally lacks authorization
  controls." It provides none of `health-monitor`'s actual design: no
  auto-expiry, no `MAX_PAUSE_DURATION`, no extension cap, no trigger
  reasoning. Adopting it would mean keeping all of that bespoke logic
  anyway, just on top of a different boolean-storage helper — no real
  simplification.
- Its event shape (`topics: ["paused"]` / `["unpaused"]`, no extra
  fields) does not carry `pause_expiry` or `trigger`, both of which
  `reporterLoop.ts`'s real pause-stats computation
  (`adr/0019`, shipped immediately before this decision) already
  depends on, having just live-verified the exact real shape of
  `health-monitor`'s own `Paused`/`Resumed` events. Switching event
  shapes now would regress a just-shipped, just-verified real
  integration for a primitive that does not even solve the problem
  `health-monitor` exists to solve.

## Real finding: the event shape confirms the RBAC swap is safe

`RoleGranted`/`RoleRevoked` are new real events this change introduces
(`topics: ["role_granted", role, account]`, `data: [caller]`, confirmed
live). `PauseState`, `Paused`, and `Resumed` are completely untouched —
the pause storage key, struct, and event shapes are byte-for-byte
identical to before this change, so `adr/0019`'s reporter loop needed no
changes and was re-verified live against the new contract without
modification (see Verification).

## Verification

`cargo test --package refluo-health-monitor`: 10 tests (6 unchanged +
4 new: `add_guardian` extends the roster without disturbing existing
guardians, `remove_guardian` revokes pause rights, a non-admin cannot
grant a role). `cargo clippy -D warnings` and `cargo fmt --check` clean.
Wasm size: 8,346 bytes (up from 4,343 bytes, still far under the 64KB
budget). Live re-verification against real testnet: `keeper/scripts/reflector_webhook_smoke_test.mjs`
(6/6) and `keeper/scripts/reporter_smoke_test.mjs` (7/7) both re-ran
clean against contracts deployed with the new `init_guardians`, and
`drills/yieldblox_drill.sh` (10/10) confirms a *contract address*
(`oracle-router`, registered as a guardian, self-authorizing its own
cross-contract `pause()` call) still passes the new `has_role` check
exactly as it passed the old `Vec::contains` check — role-based lookup
works identically for a contract guardian as for an EOA guardian, not
just tested against the account case.

## Consequences

- `init_guardians` still takes the same `Vec<Address>` argument for the
  initial roster (grants each via `grant_role_no_auth`, the documented
  constructor-equivalent path); real per-guardian changes after that
  point go through `add_guardian`/`remove_guardian`, both requiring real
  admin authorization `stellar-access` itself enforces
  (`ensure_if_admin_or_admin_role`), not a check this contract
  duplicates.
- `guardians()` changed its return type from `Result<Vec<Address>,
  CommonError>` to a plain `Vec<Address>` — role enumeration has no
  "uninitialized" state to distinguish from "zero guardians" (confirmed
  from the crate's own docs), so the old `NotInitialized` error case no
  longer applies. No caller in this workspace used the old `Result`
  wrapper.
- `add_guardian`/`remove_guardian` reject a non-admin caller with
  `stellar-access`'s own `AccessControlError`, not this contract's
  `CommonError::Unauthorized` — a different error code than `pause`/
  `resume_early` still raise, an acceptable pre-audit inconsistency
  worth normalizing before mainnet, not before.
