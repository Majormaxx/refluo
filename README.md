# Refluo

Refluo is a treasury management layer for autonomous AI agents on
Stellar/Soroban. It replaces a static funded wallet with a policy-constrained
smart account that forecasts its own burn rate, keeps a liquid buffer sized
to that forecast, deploys everything else to yield, and recalls funds back
before the buffer runs dry — while a compromised or malicious agent key
remains structurally incapable of doing anything except pay counterparties
within pre-set limits.

## Problem

Agents that pay for their own compute, API calls, and tool use need a
treasury, not a wallet. A wallet holds a balance until it hits zero, with no
notion of its own burn rate or any yield on idle capital. An agent operator
is left manually funding buffers big enough to survive worst-case burn
spikes, which is either wasteful (over-funded, sitting idle) or risky
(under-funded, agent halts mid-task). Refluo makes that trade-off explicit
and automatic: fund to a stated confidence level, earn yield on the rest,
recall on a measured SLA.

## Status & audit

Pre-audit, pre-mainnet, Phase 0 (foundations). No live deployment. Contract
crates in `contracts/` currently expose storage and config plumbing with
unit tests — the enforcement logic (policy decoders, oracle read algorithm,
pause/recovery state machine) is Phase 1–4 work and is not implemented yet.
Treat anything in this repo as scaffolding until that changes; this section
will be updated honestly as phases land rather than describing capability
that doesn't exist yet.

## Architecture

Eight on-chain contracts plus one off-chain keeper:

| Contract | Role |
|---|---|
| `vault` | Deployment recipe on OpenZeppelin `stellar-accounts` — not a contract Refluo owns |
| `policy-venue` | YieldVenueAllowlist — decodes and caps venue deployment calls |
| `policy-recall` | RecallExecutor — venue-to-vault-only fund recall, rate-limited |
| `policy-session` | SessionScope — agent hot-key expiry, caps, destination allowlist |
| `oracle-router` | Dual-feed price reads with staleness gating and rate-of-change clamping |
| `health-monitor` | Gate-seal circuit breaker — guardian or oracle-triggered pause, auto-expiring |
| `timelock` | propose → 24h delay → execute for risk-increasing admin actions |
| `risk-engine` | On-chain bounds-checker: system state + tier bookkeeping, no deployment above NORMAL |

On-chain contracts enforce bounds; an off-chain keeper (`keeper/`, not yet
built) makes the decisions — burn forecasting, oracle cross-checks, rebalance
scheduling. This split keeps the audited on-chain surface small.

## Project structure

```
refluo/
  contracts/
    common/           shared types (SystemState, OracleStatus, PriceQuote, errors)
    vault/             deployment recipe, not a WASM contract
    policy-venue/       YieldVenueAllowlist
    policy-recall/       RecallExecutor
    policy-session/       SessionScope
    oracle-router/
    health-monitor/
    timelock/
    risk-engine/
  keeper/             off-chain: forecaster / sentinel / reporter loops (not started)
  sdk/                TypeScript SDK for agent operators (not started)
  dashboard/          operator-facing web app (not started)
  drills/             scripted adversarial scenarios (not started)
  adr/                architecture decision records
```

## Decisions & trade-offs

- **OZ `stellar-accounts` over hand-rolled auth.** The context-rule/policy
  decomposition already matches what a policy-constrained treasury needs;
  hand-rolling `__check_auth` is how solo devs die. See `adr/0001`.
- **On-chain enforces, off-chain decides.** Prediction math and cross-source
  oracle corroboration live in the keeper, never on-chain — it keeps the
  audited surface to bounds-checking (caps, allowlists, staleness), not
  market analysis.
- **USDC and XLM only in v1.** No long-tail collateral until an off-chain
  liquidity-admission pipeline exists. You cannot be exploited on an asset
  you never touch.
- **Fee hook ships now, at 0%.** `risk-engine` carries a mutable `fee_bps`
  behind a setter with a hardcoded ceiling, rather than a constant, so a
  future fee doesn't require migrating every deployed customer vault. See
  `adr/0002`.
- **Gate-seal pause, not a bespoke freeze.** Cheap/broad trigger, lazy
  72h auto-expiry, narrow resume — modeled on Lido's GateSeal so a
  compromised guardian buys degraded yield for a bounded window, not a
  bricked treasury.

## Quickstart

Requires Rust with the `wasm32v1-none` target, and `stellar-cli` for
deploys (not required for build/test).

```
git clone <this repo>
cd refluo
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release --target wasm32v1-none -p refluo-risk-engine   # example; repeat per contract
```

## Testing

Each contract crate has unit tests covering its current surface (config
round-trips, storage defaults, the fee ceiling check). No property tests,
fuzz targets, or integration tests against testnet Blend/Reflector exist
yet — those are Phase 1–5 deliverables per the test matrix, not implemented.
Don't infer coverage from the presence of a `#[cfg(test)]` module; check
what's actually asserted.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and PR:
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`,
then a per-contract `wasm32v1-none` release build with a 64KB wasm size
budget that fails the build if exceeded. All four must pass before merge.

## Roadmap

Phase 0 (this scaffold) → Phase 1 (AgentVault + policies) → Phase 2
(OracleRouter, blocked on RedStone mainnet feed verification) → Phase 3
(RiskEngine + tiering) → Phase 4 (HealthMonitor + Forecaster) → Phase 5
(hardening: fuzz, external review, paid audit, mainnet canary) → Phase 6
(post-audit differentiation). Detailed phase exit criteria are tracked
locally, not in this repo.
