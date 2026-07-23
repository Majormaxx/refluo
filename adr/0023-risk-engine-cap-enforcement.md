# ADR 0023: RiskEngine.record_tier1_position() gets real cap enforcement

Status: accepted. Date: 2026-07.

## Decision

Surfaced while wiring the dashboard's `cap.breached` alert type to a real
signal (a separate, dashboard-side effort): `RiskEngine::deploy_allowed()`
is a real, correct pre-check, but `record_tier1_position()` — the actual
state-changing call — never checked it. Confirmed directly from source
(`risk-engine/src/lib.rs`, prior to this change): the function took
whatever `amount` it was given and wrote it, no `tvl_cap` check, no
`SystemState` check, nothing. `deploy_allowed()`'s own doc comment calls
this "the on-chain guarantee every policy depends on" — it wasn't actually
a guarantee, just a convention every caller was trusted to follow.

**Fixed by enforcing both checks for real inside `record_tier1_position()`
itself**, panicking with `RiskError::CapExceeded` (an error variant that
already existed in the enum, unused until now) rather than adding a new
one: state must be `Normal`, and the real new total must not exceed
`tvl_cap`.

**The cap check is deliberately not `deploy_allowed()`'s own formula.**
`record_tier1_position()` *sets* a venue's position
(`tier1_positions.set(venue, amount)`), it does not increment it.
`deploy_allowed(amount)`'s formula — current total across all venues plus
`amount` — assumes `amount` is purely additive, which is only true for a
brand-new venue. Reusing it unmodified for an update to an *existing*
venue's position would double-count that venue's own stale value: the
real new total has to be *(sum of every other venue's current position) +
amount*. A regression test proves the difference concretely (see
Verification) — a case that formula would have wrongly rejected.

## Considered: a `CapBreached` contract event, rejected

The instinct was to add a `CapBreached` event alongside the panic, matching
this workspace's own convention of a real, `getEvents()`-queryable signal
per meaningful state change. That doesn't work here, for a reason specific
to how Soroban (and any host with atomic transaction semantics) actually
executes: a panicking invocation discards *all* of its effects, storage
writes and published events alike, the same way an EVM revert drops its
logs. A `CapBreached` struct defined here could never actually survive to
be observed on-chain — it would be a real-looking event that is
architecturally unreachable, which is worse than no event at all: it reads
as done when it silently isn't.

The real, honest signal for a `cap.breached` alert (tracked as a dashboard
concern, not this contract's) is the caller — in production, the
keeper — observing its own rejected transaction. A `FAILED` transaction
result decoding to `RiskError::CapExceeded` is exactly as real as an
event; it's simply observed from the transaction result rather than
replayed from `getEvents()` after the fact.

## Live verification

Deployed a fresh `risk-engine`
(`CDEGC5DI7R3GCKGUDRN3XIY5FWIKSGLW4UBVK4RMPWFAS3CWKV5BWZ5C`, `tvl_cap =
1_000_000_000_000`) and drove real calls: a 500B position recorded
successfully; a second call attempting 5000B on the same venue (would push
the real total to 5000B) rejected on-chain with `Error(Contract, #3)`
(`RiskError::CapExceeded`) — the position's real on-chain value confirmed
unchanged afterward. `cargo test --package refluo-risk-engine`: 38 tests
(33 unchanged + 5 new — a fresh over-cap deployment rejected, a genuine
breach across two real venues rejected, an *existing* venue's position
update correctly evaluated against the corrected total rather than the
naive double-counting one, non-`Normal` state still rejected regardless of
amount, a non-keeper caller rejected). `cargo clippy -D warnings` and
`cargo fmt --check` clean.
`contracts/risk-engine/scripts/testnet_smoke_test.sh` extends its existing
live SystemState-transition coverage with this same cap-enforcement cycle
against a fresh deploy, run end to end against real testnet infrastructure
alongside `HealthMonitor.extend()`'s own live cycle (`adr/0022`): 13/13
checks passed, 0 failed.

## Consequences

- `record_tier1_position()`'s signature is unchanged (still returns
  nothing, panics on rejection) — the only real caller in this workspace
  today is a same-file unit test (confirmed via a targeted search before
  making this change), so this closes a real gap with zero blast radius on
  any production contract. `policy-venue` does not call this function
  directly today; whichever caller eventually does (in production, the
  keeper, matching the existing keeper-authorized pattern
  `set_tier0_target` already uses) now gets real enforcement for free,
  not something it has to remember to check itself.
- `deploy_allowed()` is unchanged and remains a valid, cheap *additive*
  pre-check for "can I deploy this much more, as a new position" — it does
  not attempt to answer the *update-an-existing-venue* question
  `record_tier1_position()`'s own internal check now handles correctly on
  its own.
