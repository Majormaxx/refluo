# Refluo

Refluo is a treasury management layer for autonomous AI agents on
Stellar/Soroban. It replaces a static funded wallet with a policy-constrained
smart account that forecasts its own burn rate, keeps a liquid buffer sized
to that forecast, deploys everything else to yield, and recalls funds back
before the buffer runs dry. A compromised or malicious agent key remains
structurally incapable of doing anything except pay counterparties within
pre-set limits.

## Problem

Agents that pay for their own compute, API calls, and tool use need a
treasury, not a wallet. A wallet holds a balance until it hits zero, with no
notion of its own burn rate or any yield on idle capital. An agent operator
is left manually funding buffers big enough to survive worst-case burn
spikes, which is either wasteful (over-funded, sitting idle) or risky
(under-funded, agent halts mid-task). Refluo makes that trade-off explicit
and automatic: fund to a stated confidence level, earn yield on the rest,
recall on a measured SLA.

## Demo

None yet. No agent has run against a deployed Refluo vault — nothing is
live to point a demo at. First honest demo candidate is a testnet vault
with an agent key paying via x402 within caps; this section gets a real
link or recording once that exists, not before.

## Status & audit

Pre-audit, pre-mainnet, no live deployment. `vault`, `policy-venue`,
`policy-recall`, and `policy-session` have real enforcement logic, tested
individually and cross-contract (deploying a vault, wiring all three
policies onto it, and confirming the admin-alone self-rescue path all pass
in `contracts/integration-tests`). `oracle-router`, `health-monitor`,
`timelock`, and `risk-engine` remain scaffolding only: storage and config
plumbing, no enforcement logic yet. This section will keep tracking reality
as the repo progresses, not describing capability that doesn't exist yet.

## Architecture

Eight on-chain contracts plus one off-chain keeper:

| Contract | Role |
|---|---|
| `vault` | Thin wrapper on OpenZeppelin `stellar-accounts`: `SmartAccount` + `CustomAccountInterface`, no Refluo-specific auth logic |
| `policy-venue` | YieldVenueAllowlist: decodes and caps venue deployment calls |
| `policy-recall` | RecallExecutor: venue-to-vault-only fund recall, rate-limited |
| `policy-session` | SessionScope: agent hot-key expiry, caps, destination allowlist |
| `oracle-router` | Dual-feed price reads with staleness gating and rate-of-change clamping |
| `health-monitor` | Gate-seal circuit breaker: guardian or oracle-triggered pause, auto-expiring |
| `timelock` | propose → 24h delay → execute for risk-increasing admin actions |
| `risk-engine` | On-chain bounds-checker: system state + tier bookkeeping, no deployment above NORMAL |

On-chain contracts enforce bounds; an off-chain keeper (`keeper/`, not yet
built) makes the decisions: burn forecasting, oracle cross-checks, rebalance
scheduling. This split keeps the audited on-chain surface small.

## Project structure

```
refluo/
  contracts/
    common/           shared types (SystemState, OracleStatus, PriceQuote, BlendRequest, errors)
    vault/             SmartAccount + CustomAccountInterface wrapper
    policy-venue/       YieldVenueAllowlist
    policy-recall/       RecallExecutor
    policy-session/       SessionScope
    oracle-router/
    health-monitor/
    timelock/
    risk-engine/
    integration-tests/ cross-contract tests (vault + policies wired together), dev-only
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
  oracle corroboration live in the keeper, never on-chain. It keeps the
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
  72h auto-expiry, narrow resume. Modeled on Lido's GateSeal, so a
  compromised guardian buys degraded yield for a bounded window, not a
  bricked treasury.
- **Verify framework internals against source before writing logic against
  them.** Building the vault and policy contracts against `stellar-accounts`'
  real source (not docs or pseudocode) caught five wrong assumptions: wrong
  `soroban-sdk` version, a nonexistent `can_enforce` trait method, a
  nonexistent `Context` variant, an assumption that OZ ships a deployable
  account contract, a nonexistent Blend `Claim` request type. See `adr/0004`.

## Quickstart

Requires Rust with the `wasm32v1-none` target, and `stellar-cli` (v27+) —
required for build too, not just deploy: `stellar-accounts`' pinned
`soroban-sdk` feature (`experimental_spec_shaking_v2`) only builds via
`stellar contract build`, plain `cargo build --target wasm32v1-none` fails
with a clear error naming the fix.

```
git clone <this repo>
cd refluo
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
stellar contract build --package refluo-vault   # example; repeat per contract, or omit --package for all
```

## Testing

`vault`, `policy-venue`, `policy-recall`, `policy-session` have real
enforcement-logic test suites: unit tests per contract plus property tests
(via `proptest`) for the invariants that matter most — epoch caps never
exceeded across any interleaving, Blend's risk-increasing/administrative
request types are unreachable under any input, recall destination always
equals the vault, rate limits are monotone, session expiry has no off-by-one.
`contracts/integration-tests` proves the composition unit tests can't: a
deployed vault's own `add_context_rule` cross-calls into each policy's
`install`, and an admin acting alone can strip every policy-bearing rule
with zero keeper or dashboard involvement (the self-rescue guarantee,
verified, not just asserted). `oracle-router`, `health-monitor`, `timelock`,
`risk-engine` still only have config round-trip tests — no property tests,
fuzz targets, or testnet integration tests against real Blend/Reflector
exist yet anywhere in the repo. Don't infer coverage from the presence of a
`#[cfg(test)]` module; check what's actually asserted.

## Monitoring

None yet, correctly: there's no live system to monitor. This section stays
empty until the operator dashboard's SLA panel (Tier 0 hit rate, recall
latency, pause count, forecaster error) goes live against real telemetry.
Not the same gap as Demo: a dashboard spec exists internally, it just
isn't built.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and PR:
`cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`,
then a per-contract `wasm32v1-none` release build with a 64KB wasm size
budget that fails the build if exceeded. All four must pass before merge.

## What's left

Enforcement logic for `oracle-router` (blocked on RedStone mainnet feed
verification), `health-monitor`, `timelock`, and `risk-engine`. Then the
off-chain keeper, the TypeScript SDK, and the operator dashboard, none of
which exist yet. Then hardening: fuzz targets, external review, a paid
audit, and a mainnet canary under a hardcoded TVL cap before any real
customer funds. Detailed sequencing and exit criteria are tracked locally,
not in this repo.
