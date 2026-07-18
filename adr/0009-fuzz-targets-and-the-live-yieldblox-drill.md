# ADR 0009: Real cargo-fuzz targets and the live YieldBlox drill

Status: accepted. Date: 2026-07.

## Decision

Two real cargo-fuzz targets now exist, matching what the PRD names
specifically: OracleRouter's read algorithm and the Blend `submit()`
decoder.

- `contracts/oracle-router/fuzz/fuzz_targets/pricing_math.rs` fuzzes
  `rescale`, `divergence_bps`, and `roc_ok`, the pure arithmetic core of
  `get_price`, across the full `i128`/`u32` domain. These three needed no
  `Env` to begin with except `roc_ok`, which took the entire
  `AssetOracleConfig` (an `Address`-bearing struct) to read one `u32`
  field. Narrowed to take `max_roc_per_update: u32` directly, a real
  simplification independent of fuzzing, not a workaround: the function
  now only depends on what it actually uses. 43.4 million runs in 120s,
  zero crashes, coverage plateaued (123/138 features).
- `contracts/policy-venue/fuzz/fuzz_targets/blend_submit_decode.rs`
  drives the real, deployed `PolicyVenue::enforce()` entry point with
  adversarial `request_type` values across the full `u32` range (not
  just the known-valid and hand-picked-invalid values property tests
  already cover) and extreme `i128` amounts. Controlled rejections via
  `panic_with_error!`, surfaced as `Err` through `try_enforce`, are the
  correct outcome for a bad request and are not fuzzer findings; only a
  genuine crash would be. 19,801 runs in 120s (each spins up a full
  `Env` and deployed contract, so far fewer iterations than the pure-math
  target), zero crashes.

`contracts/mock-price-feed`, a new contract implementing sep-40-oracle's
real `PriceFeedTrait` with an admin-settable price, exists to drive the
live YieldBlox drill: a real testnet feed can't be made to report a false
price on demand, so this is the controlled stand-in for the one input an
actual attack manipulates. `PriceFeedClient` (the same client OracleRouter
calls real Reflector and RedStone with) works against it unmodified,
proving the cross-contract call itself is real, not the mock.

`drills/yieldblox_drill.sh` runs the drill live: seeds the mock matching
Reflector's real live price, confirms Healthy, spikes it 100x, confirms
OracleRouter reports Degraded and RiskEngine's `check_and_trip` escalates
to Emergency with `deploy_allowed` now false, resets the feed, confirms
OracleRouter recovers on its own with no admin call, no stored flag to
clear. 7/7 assertions passed on a live run.

Recalls staying available during an oracle incident, the third leg of the
drill's definition, is verified by source inspection, not a live call:
`contracts/policy-recall/src/lib.rs` contains zero references to
oracle status, price data, or `SystemState` anywhere. `RecallExecutor`
cannot be blocked by a degraded oracle because nothing in it reads one.

## Why

Property tests (`proptest`) already covered these functions against
values someone thought to pick. Fuzzing covers values nobody picked,
which is exactly the class of input a manipulated feed or a malformed
calldata payload would actually be. The PRD names cargo-fuzz specifically
for this reason, not as a synonym for property testing.

A live drill against a real 100x spike is the only way to prove the
`Degraded`-status branch of `check_and_trip`, `resolve_both_available`,
and `deploy_allowed` actually composes correctly across three separately
deployed contracts on a real network, the same reasoning that produced
every other live smoke test in this workspace. A mocked-in-a-unit-test
version of this already existed (the divergence property tests); what it
could not prove is that the real deployed `RiskEngine` genuinely receives
and correctly reacts to a real cross-contract call reporting Degraded,
under real transaction and auth semantics, not a Rust function call
inside one process.

## Consequences

- `roc_ok`'s narrowed signature is a small public API change; both call
  sites in `resolve_both_available` and `resolve_one_available` now pass
  `cfg.max_roc_per_update` explicitly instead of the whole config.
- Fuzzing is not a one-shot pass/fail gate the way unit tests are. The
  120-second runs here prove the harnesses work and found nothing in that
  window; they are not a permanent guarantee. Longer, periodic runs
  (nightly, pre-release) are the appropriate cadence going forward, not
  every commit, matching the existing gate-test-vs-periodic-eval split.
- RiskEngine's `SystemState` does not auto-recover once the drill trips
  Emergency. The drill script says so explicitly and treats the
  keeper-gated recovery path as intended behavior, not a bug. Recovery
  requires
  `keeper_advance_state`, deliberately, per `adr/0006`; this drill proves
  the escalation and the oracle-level auto-resume, not RiskEngine's
  separate recovery step.
