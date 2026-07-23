# ADR 0022: HealthMonitor.extend()

Status: accepted. Date: 2026-07.

## Decision

`HealthMonitor.extend()` was the last of the three functions this
contract's own doc comment named as "genuinely unbuilt" (`adr/0019`,
`adr/0020`) — the gap surfaced concretely while closing the operator
dashboard's guardian-panel gaps against the PRD: the extension-request flow
was disclosed in the UI rather than faked, since there was no real call to
wire it to. This closes it for real.

**Auth reuses `resume_early`'s exact shape**: `admin.require_auth()` plus
`admin == ac::get_admin(&e)`. No new access-control primitive — the real
2-of-3 multisig this needs composes one layer up at the vault's own smart
account, exactly as `resume_early`'s own comment already documents; this
contract only ever sees the single resolved admin address either way.

**Extends by resetting to a fresh `MAX_PAUSE_DURATION` (72h) from the call
time, not stacking additively onto whatever time was left.** Capped at
`MAX_EXTENSIONS` (2) real extensions via `extensions_used`, both fields
already present in `PauseState` as unused scaffolding before this change
(`extensions_used: u32`, `const MAX_EXTENSIONS: u32 = 2`, previously
`#[allow(dead_code)]`).

**A real finding changed the implementation from the first draft**:
`pause()` has no guard against being called again while already paused —
it unconditionally overwrites the whole `PauseState`, including
`extensions_used`, on every call. That means `extend()` cannot simply
trust the stored `paused` flag; it independently re-derives liveness the
same way `status()` itself does (`paused && now < pause_expiry`), so an
admin can't "resurrect" a pause that has already lazily auto-expired by
calling `extend()` instead of going back through `pause()`'s guardian gate.

New `Extended` event, matching the sibling `Paused`/`Resumed` naming
convention (no `Event` suffix — that belongs to Timelock's own, separate
convention): `topics: ["extended", extensions_used]`, `value:
{pause_expiry}`, mirroring `Paused`'s value shape. Confirmed live rather
than assumed from the Rust struct, the same lesson every prior ADR
touching an event shape in this workspace has already learned
(`adr/0017`, `adr/0019`, `adr/0021`).

Failure cases reuse `refluo_common::CommonError`'s existing variants,
already sufficient without adding new ones: `Unauthorized` (wrong signer),
`BadState` (not currently paused, or the pause has already lapsed —
covers the double-check above), `CapExceeded` (a 3rd extension attempt).

## Live verification

Deployed a fresh `health-monitor` to testnet
(`CDCUGTD3OPX3N474CKHQJRO2EWPNGYDZSV5MC3QJV3XRJHLGXCFMXSVO`) and drove the
real cycle end to end: `pause()` → `extend()` (real event: `topics:
["extended", 1]`, `value: {pause_expiry: 1785093589}`) → `extend()` again
(`extensions_used: 2`) → a 3rd `extend()` correctly rejected on-chain with
`Error(Contract, #5)` (`CommonError::CapExceeded`), then `resume_early()`
confirmed via a real `status()` read before/after. `cargo test --package
refluo-health-monitor`: 15 tests (10 unchanged + 5 new — extension
succeeds and grants a real fresh window, rejected when not paused, rejected
once already auto-expired, capped at `MAX_EXTENSIONS`, rejected from a
non-admin signer). `cargo clippy -D warnings` and `cargo fmt --check`
clean. `contracts/risk-engine/scripts/testnet_smoke_test.sh` (which deploys
both contracts together) re-runs this same cycle as part of its own
formalized live suite: 13/13 checks passed against a fresh testnet
deployment, 0 failed.

## Consequences

- `MAX_EXTENSIONS` bounds a single incident to at most 72h + 2×72h = 216h
  of guardian-triggered pause before an admin must either resume it or let
  it lapse for good — a deliberate ceiling, not an oversight: an admin
  that needs the vault paused longer than that has a decision to make, not
  an indefinitely renewable snooze button.
- `pause()`'s pre-existing lack of a re-pause guard is unchanged by this
  ADR (out of scope here) but is now a documented, load-bearing fact for
  any future consumer of `Paused`/`Extended` events: a real pause-history
  reconstruction (dashboard `/incidents`) cannot naively pair each `Paused`
  with the next chronological `Resumed` — a second `Paused` while one is
  already open must be treated as replacing that open episode, not
  starting a concurrent one.
