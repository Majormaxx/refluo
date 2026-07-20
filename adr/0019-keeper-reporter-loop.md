# ADR 0019: Reporter loop and the four real SLA metrics

Status: accepted. Date: 2026-07.

## Decision

`keeper/src/reporter.ts` is the pure computation layer (same split as
`forecaster.ts`/`forecasterLoop.ts`): four functions, one per metric the
implementation spec names for this loop.

- `computeTier0HitRate` — fraction of real Tier 0 balance samples that met
  or exceeded the applied target at that moment.
- `computePauseStats` — real pause count and total real duration within a
  reporting window, clipped at the window edges, a pause's real end being
  whichever comes first of an early `Resumed` event or its own recorded
  auto-expiry.
- `computeRecallLatencyHistogram` — p50/p95/p99 over real
  detected-to-executed latencies.
- `computeForecasterError` / `backtestForecasterError` — backtests the
  sizing model against real chain history: each hour's prediction uses
  only observations strictly before it, never its own realized value, so
  the error measures real generalization, not the model grading answers
  it already saw.

`keeper/src/reporterLoop.ts` is the real integration. Two different real
data sources feed it, deliberately not one:

- **Pause count/duration comes straight from chain**, not from any local
  record: `fetchPauseEvents` queries `HealthMonitor`'s own real emitted
  events. The exact topic/value shape was confirmed live rather than
  assumed from the Rust source — `Paused` decodes to
  `topics: ["paused", ["Guardian"]]`, `value: {pause_expiry}`; `Resumed`
  decodes to `topics: ["resumed", true]`, `value: {}`. Both event names
  are lowercased from the struct name, not the `PascalCase` the source
  reads. This is the authoritative source because it doesn't depend on
  this specific keeper process having stayed up continuously — any
  observer could reconstruct the same pause history from chain alone.
- **Tier 0 samples and recall latency come from a local metrics log**
  (`keeper/src/metricsLog.ts`, a small shared append-only JSONL helper),
  because there is no real on-chain time series for either: `forecasterLoop.ts`
  now appends a `tier0_sample` event every tick (the real balance/target
  it already computed, no separate query needed) and a `recall_triggered`
  event whenever it fires a real recall, timestamped both when the
  shortfall was first detected and when the resulting transaction really
  landed. This is the one piece reporter genuinely cannot recompute from
  chain alone, the same category `forecasterLoop.ts`'s own hysteresis
  state file already occupies (`adr/0017`).
- **Forecaster error reuses `forecasterLoop.ts`'s own real burn-event
  fetcher** (`fetchHourlyBurnObservations`, exported for this purpose),
  so the backtest runs against the exact same real chain data the model
  itself would have seen, not a separately-fetched copy that could drift.

"Ship to a dashboard" is the spec's own phrase for this loop's output;
`dashboard/` doesn't exist yet (tracked separately). Until it does,
`tick()` writes the real computed `SlaSnapshot` to a local JSON file — the
telemetry itself is real today, a web UI reading it is a distinct,
already-tracked gap, not something this loop should fake in the meantime.

## Real finding: the event topic/value shape had to be read live, again

Same lesson as `adr/0017`'s USDC transfer topics: guessing from a
`#[contractevent]` struct's Rust field order is not reliable.
`PauseTrigger` (a unit-variant enum) round-trips through the topic as
`["Guardian"]`, a one-element vec of its tag name, matching the same
mixed-enum ScVal convention `adr/0016` already found for
`ContextRuleType`, not a bare symbol. `Resumed`'s single field being a
topic (`#[topic] early: bool`) means its `value` payload is an empty map,
not the boolean itself. Confirmed by deploying a fresh `HealthMonitor`,
pausing and resuming it for real, and reading the actual emitted events
back with `scValToNative`, the same practice this workspace has used for
every other on-chain shape question, before writing the decoder.

## Live verification

`keeper/scripts/reporter_smoke_test.mjs`: a real deployed `HealthMonitor`
is really paused and really resumed roughly 20 seconds apart, and
`reporterLoop.tick()` correctly reconstructs one real pause event with
that real duration from chain alone. A real fresh vault is funded and a
real admin-authorized USDC transfer moves funds out of it (`R_ADMIN`,
context rule 0, no destination restriction — that policy's whole point),
confirmed landing, feeding a real (if singular, given the vault is
minutes old) bucket into the real burn-observation fetch the forecaster-
error backtest runs against. Two `tier0_sample` events (one hit, one
miss) and one `recall_triggered` event (a real 30s detected-to-executed
gap) are seeded through the exact same `appendMetricEvent` function
production code calls, then read back by a real `tick()`: hit rate comes
back exactly 0.5, recall latency's p50 comes back exactly 30s, and the
final snapshot file on disk matches what `tick()` returned in memory.
7/7 passed live.

## Consequences

- Tier 0 hit rate and recall latency are only as complete as this
  keeper's own metrics log: a keeper that has never run, or whose log was
  reset, reports zero samples for those two metrics, not a fabricated
  number, exactly what `computeTier0HitRate`'s empty-input behavior
  already guarantees. A production deployment's real SLA history only
  starts accumulating once the loops are actually running, same as any
  real monitoring system on day one.
- The forecaster-error backtest is bounded by the same RPC event
  retention window `adr/0017` already found (about 7 days), so
  `REPORTER_FORECASTER_ERROR_BACKTEST_HOURS` beyond that ceiling can't
  see further real history no matter how it's configured.
- Pause pairing assumes `HealthMonitor`'s single `PauseState` slot: a real
  `Paused` event with no intervening `Resumed` before the next `Paused`
  is treated as ending at its own real auto-expiry, matching the
  contract's own lazy-unpause semantics (`status()` clears itself at
  expiry with no event required).
