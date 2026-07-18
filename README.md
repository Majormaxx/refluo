# Refluo

Refluo gives an autonomous agent on Stellar/Soroban a funded treasury
instead of a plain wallet. A smart-contract layer tracks how fast the
agent spends, keeps just enough liquid on hand to cover it, and puts the
remainder into yield until it's needed back. Every payment the agent's
hot key can make is capped and allowlisted at the contract level, so a
stolen or misbehaving key can drain nothing beyond what the caps allow.

## Problem

An AI agent that pays for its own API calls, compute, and tool usage
burns money unpredictably. Point it at a plain wallet and an operator is
stuck guessing a buffer size by hand: too much and the funds sit idle
earning nothing, too little and the agent stalls mid-task waiting on a
manual top-up. Refluo turns that guess into a number the agent's own
history sets automatically, keeps everything above that number earning
yield, and pulls funds back on a schedule tight enough that the agent
never notices the difference.

## Demo

No agent has run against a deployed Refluo vault yet, so that demo still
needs a real link or recording. One piece of it is live today: OracleRouter
is deployed on Stellar testnet, reading XLM's price from real Reflector
Pulse and RedStone feeds simultaneously and cross-checking them.
`contracts/oracle-router/scripts/testnet_smoke_test.sh` reproduces it: it
deploys fresh, configures both feeds, and confirms a healthy quote both
providers agree on to within ~0.1%.

## Status & audit

Pre-audit, pre-mainnet, no full end-to-end deployment. `vault`,
`policy-venue`, `policy-recall`, and `policy-session` have real enforcement
logic, tested individually and cross-contract (deploying a vault, wiring
all three policies onto it, and confirming the admin-alone self-rescue path
all pass in `contracts/integration-tests`). `oracle-router` has real
enforcement logic too (staleness gating, divergence bands, TWAP smoothing,
a rate-of-change clamp) and is verified live against real Reflector and
RedStone testnet contracts, going beyond what mocks alone could confirm.
`health-monitor` has a real
guardian-triggered, auto-expiring pause and an admin-gated early resume,
also live-verified. `risk-engine` has a real four-state bounds-checker
(Normal/PreemptiveDrain/Emergency/Paused) that reads its inputs from real
contracts, not caller-supplied claims: a real cross-call to `oracle-router`
for price status, a real cross-call to `health-monitor` for pause status,
and a real on-chain USDC balance read for the critical-floor check. Every
transition and rejection path has been driven live on testnet, reproducible
via `contracts/risk-engine/scripts/testnet_smoke_test.sh`; see `adr/0006`
for what that live run found that the unit suite couldn't. `timelock`
remains scaffolding only: storage and config plumbing, no enforcement logic
yet. This section will keep tracking reality as the repo progresses, not
describing capability that doesn't exist yet.

## Architecture

Eight on-chain contracts plus one off-chain keeper:

| Contract | Role |
|---|---|
| `vault` | Thin wrapper on OpenZeppelin `stellar-accounts`: `SmartAccount` + `CustomAccountInterface`, no Refluo-specific auth logic |
| `policy-venue` | YieldVenueAllowlist: decodes and caps venue deployment calls |
| `policy-recall` | RecallExecutor: venue-to-vault-only fund recall, rate-limited |
| `policy-session` | SessionScope: agent hot-key expiry, caps, destination allowlist |
| `oracle-router` | Dual-feed price reads with staleness gating and rate-of-change clamping |
| `health-monitor` | Gate-seal circuit breaker: guardian-triggered pause, 72h auto-expiry, admin-gated early resume |
| `timelock` | propose → 24h delay → execute for risk-increasing admin actions |
| `risk-engine` | On-chain bounds-checker: reads real oracle status, pause status, and USDC balance; no deployment above NORMAL |

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

- **OZ `stellar-accounts` over hand-rolled auth.** A custom `__check_auth`
  implementation is exactly the kind of code a small team gets wrong once
  and pays for permanently; OZ's context-rule/policy model already covers
  the shape a policy-constrained treasury needs, audited and maintained by
  someone else. See `adr/0001`.
- **Bounds on-chain, judgment off-chain.** Anything that requires weighing
  evidence (burn forecasting, cross-checking oracle feeds against each
  other) runs in the keeper. Contracts only ever check a number against a
  limit (caps, allowlists, staleness windows), which is what keeps the
  code worth auditing small.
- **USDC and XLM only in v1.** No long-tail collateral until an off-chain
  liquidity-admission pipeline exists, so there's no asset in the system
  thin enough for a single trade to manipulate its price.
- **Fee hook ships now, at 0%.** `risk-engine` carries a mutable `fee_bps`
  behind a setter with a hardcoded ceiling, rather than a constant, so a
  future fee doesn't require migrating every deployed customer vault. See
  `adr/0002`.
- **Gate-seal pause, not a bespoke freeze.** Any guardian can trigger it,
  it self-clears after 72h if nobody acts, and resuming early needs the
  admin threshold. Copied from Lido's GateSeal because it bounds the
  downside of a false or malicious pause to a fixed window of missed
  yield instead of an indefinitely frozen contract.
- **Verify framework internals against source before writing logic against
  them.** Building the vault and policy contracts against `stellar-accounts`'
  real source (not docs or pseudocode) caught five wrong assumptions: wrong
  `soroban-sdk` version, a nonexistent `can_enforce` trait method, a
  nonexistent `Context` variant, an assumption that OZ ships a deployable
  account contract, a nonexistent Blend `Claim` request type. See `adr/0004`.
- **One oracle client for both feeds, isolated on its own `soroban-sdk`
  version.** Reflector's and RedStone's price types are structurally
  identical to the standard `sep-40-oracle` crate, confirmed from all three
  sources, so `oracle-router` depends on that crate directly instead of
  hand-rolling two integrations, at the cost of pinning a different
  `soroban-sdk` than the rest of the workspace, since nothing requires
  `oracle-router` and `stellar-accounts` to share a compilation unit. See
  `adr/0005`, including a real bug that deploying to testnet found and a
  same-shaped mock never would have: Reflector and RedStone key the same
  asset differently, and a config assuming one shared key was wrong.
- **`risk-engine` reads real contracts, never trusts a caller's claim.**
  Every condition that moves `SystemState` more conservative comes from a
  live cross-contract call, never an argument a caller could lie about:
  `oracle-router` for price status, `health-monitor` for pause status, a
  real USDC balance read for the critical-floor check. See `adr/0006`,
  including a live-testnet-only finding: the real testnet USDC contract
  wraps a classic Stellar asset, and its balance check traps for any
  account without an established trustline instead of returning zero, a
  path no unit test double could have exercised.

## Quickstart

Requires Rust with the `wasm32v1-none` target, and `stellar-cli` (v27+),
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
(via `proptest`) for the invariants that matter most: epoch caps never
exceeded across any interleaving, Blend's risk-increasing/administrative
request types are unreachable under any input, recall destination always
equals the vault, rate limits are monotone, session expiry has no off-by-one.
`contracts/integration-tests` proves the composition unit tests can't: a
deployed vault's own `add_context_rule` cross-calls into each policy's
`install`, and an admin acting alone can strip every policy-bearing rule
with zero keeper or dashboard involvement (the self-rescue guarantee,
verified, not just asserted). `oracle-router` has 15 unit/property tests
against mock feeds (staleness, divergence bands, TWAP, the rate-of-change
clamp's dual-confirmation exemption) plus a live testnet smoke test against
real Reflector and RedStone contracts, reproducible via
`contracts/oracle-router/scripts/testnet_smoke_test.sh`, not a one-off.
`health-monitor` has 7 tests covering guardian-only pause, non-guardian
rejection, 72h auto-expiry, and admin-gated early resume including the
rejection path. `risk-engine` has 22 tests covering config validation, tier
bookkeeping, every upward `check_and_trip` transition against a real
Stellar Asset Contract balance check, and every `keeper_advance_state`
recovery and rejection path, plus a live testnet smoke test
(`contracts/risk-engine/scripts/testnet_smoke_test.sh`) that drives the
same transitions against the real deployed `oracle-router` and
`health-monitor` and a real USDC balance read. `timelock` still only has a
config round-trip test, no property tests or fuzz targets yet. Don't infer
coverage from the presence of a `#[cfg(test)]`
module; check what's actually asserted.

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

Enforcement logic for `timelock` (`oracle-router`, `health-monitor`, and
`risk-engine` are done and testnet-verified). Then the off-chain keeper,
the TypeScript SDK, and the operator dashboard, none of which exist yet.
Then hardening: fuzz targets, external review, a paid audit, and a mainnet
canary under a hardcoded TVL cap before any real customer funds. Detailed
sequencing and exit criteria are tracked locally, not in this repo.
