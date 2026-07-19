# ADR 0010: OracleRouter's check_and_trip is a real automated guardian, not a status read

Status: accepted. Date: 2026-07.

## Decision

`OracleRouter::check_and_trip(asset, health_monitor)` now does what its
name always claimed: on a genuinely degraded read, it makes a real
cross-contract call to `HealthMonitorClient::pause()`, self-authorized as
its own contract address, the same self-authorizing pattern `timelock`
already uses to call `risk-engine`. Before this, the function only
matched the price status against `Degraded`/`HardStop` and returned a
bool, no state mutation, no cross-call, despite the PRD describing it
elsewhere as "the permissionless `check_and_trip()` crank" serving as an
automated guardian on a vault's `HealthMonitor` guardian roster, "so
pause capability doesn't depend on a human being awake."

The call uses `try_pause`, not `pause`, deliberately: a vault whose
`HealthMonitor` hasn't registered `OracleRouter`'s address as one of its
guardians must still get a correct answer back from `check_and_trip`, not
a reverted transaction. Registering the guardian is an opt-in the vault's
own admin makes on `HealthMonitor`, not something `OracleRouter` can or
should force.

Live-verified on testnet via `drills/yieldblox_drill.sh`: `OracleRouter`
registered as a guardian on a real `HealthMonitor`, a real 100x spike,
`check_and_trip` called directly, `HealthMonitor.status()` genuinely
becomes `true`, confirmed by reading it back from the deployed contract,
not asserted. Downstream, `RiskEngine`'s own `check_and_trip` now
observes a real paused `HealthMonitor` for the first time in this
workspace and correctly escalates to `Paused`, not `Emergency`, since
pause status is checked ahead of oracle status in its own logic.
The unregistered-guardian path (a vault that hasn't opted in) is
unit-tested (`check_and_trip_still_reports_tripped_even_if_guardian_unregistered`),
not additionally live-verified, since the behavior under test is
`try_pause`'s standard error-handling semantics, not anything specific to
a live network.

## Why

A function named `check_and_trip` that only ever reads and never trips
anything is exactly the gap the "no stubs" rule exists to catch: it type-checks,
it compiles, it even has a plausible-sounding name, and it does
nothing the name promises. This one sat unnoticed through the original
build because nothing in the workspace called it, so no test ever
exercised what it was supposed to do, only what it happened to do.

## Consequences

- `check_and_trip`'s signature changed from `(asset)` to
  `(asset, health_monitor)`. No other contract or script called the old
  signature (confirmed by search before making the change), so this
  wasn't a breaking change to anything live.
- `drills/yieldblox_drill.sh` registers `OracleRouter`'s deployed address
  as a `HealthMonitor` guardian as part of its setup, exactly the
  production wiring a real vault operator would need to do to get the
  automated-guardian behavior.
- Repeated calls to `check_and_trip` while a feed stays degraded will
  keep re-extending `HealthMonitor`'s 72h pause window each time, since
  `pause()` always sets a fresh expiry. This is intentional, not an
  oversight: letting a still-degraded oracle's pause silently expire
  after 72h would be the wrong failure mode.
