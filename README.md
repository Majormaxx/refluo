# Refluo

[![CI](https://github.com/Majormaxx/refluo/actions/workflows/ci.yml/badge.svg)](https://github.com/Majormaxx/refluo/actions/workflows/ci.yml)

Refluo gives an autonomous agent on Stellar/Soroban a funded treasury
instead of a plain wallet: a smart-contract layer that tracks burn rate,
keeps just enough liquid to cover it, and puts the remainder into yield.
Every payment an agent's hot key can make is capped and allowlisted at
the contract level, so a stolen or misbehaving key can drain nothing
beyond what the caps allow.

## Demo

`oracle-router` is live on Stellar testnet, reading XLM's price from real
Reflector Pulse and RedStone feeds simultaneously and cross-checking them.
`contracts/oracle-router/scripts/testnet_smoke_test.sh` reproduces it end
to end: deploy, configure both feeds, confirm a healthy quote both
providers agree on to within ~0.1%. No agent has run against a deployed
vault yet, so a full end-to-end demo doesn't exist.

## Status

Pre-audit, pre-mainnet. Every on-chain contract has real enforcement
logic, verified live on testnet against real deployed infrastructure
(see Architecture for what each contract does, Testing for how that's
verified). No audit yet; reports will be linked here once one happens.

## Deployed contracts (Stellar testnet)

Reference deployment, kept live for manual inspection. Each contract's
smoke test script deploys and verifies its own fresh instance on every
run; nothing here depends on these specific addresses staying up.

| Contract | Address |
|---|---|
| `vault` | `CCVJGN5RWTGJBNCTBC6LAO4MDOCN34LJSSP2JDU7IFY43A4HHI4ZUDVV` |
| `policy-admin-threshold` | `CARR5GDAUMF4DTH4YL43AFXNONCPSTL6NIEBZGSVEA7JIJYYAKC6GMWS` |
| `oracle-router` | `CBDVIRUWVWC7M2ZJH7XDJNYCURUPQMO4F3AIX24CMY43QRY5V3RCN2MX` |
| `health-monitor` | `CDRDZHLE62WPYCGJ4NREXVJXW3PWFBZRNEDNV3P526PXELAV3ARSNIXX` |
| `risk-engine` | `CDAQLFJU3W26D3CKKXSF4CXGM3HKOA6ANJPWZA6XVFDFCRSZXX73FORY` |
| `timelock` | `CCQY2XVKY77VDFYKG6PCUGOFHYEDFYTOGVK4PBTHGHPP2YS446RFZTAV` |

`vault` is deployed with a real 2-of-3 admin multisig (three distinct
testnet keys, `policy-admin-threshold` enforcing the threshold), the
first live deployment of `vault` or any of its policies.

Not mainnet-deployed.

## Architecture

Ten on-chain contracts plus one off-chain keeper:

| Contract | Role |
|---|---|
| `vault` | Thin wrapper on OpenZeppelin `stellar-accounts`: `SmartAccount` + `CustomAccountInterface` |
| `policy-admin-threshold` | Real M-of-N multisig gate for `R_ADMIN`, 2-of-3 in production |
| `policy-venue` | YieldVenueAllowlist: decodes and caps venue deployment calls |
| `policy-recall` | RecallExecutor: venue-to-vault-only fund recall, rate-limited |
| `policy-session` | SessionScope: agent hot-key expiry, caps, destination allowlist |
| `policy-swap` | SwapExecutor: capped USDC->XLM top-up via Soroswap, oracle-derived slippage floor |
| `oracle-router` | Dual-feed price reads with staleness gating and rate-of-change clamping |
| `health-monitor` | Gate-seal circuit breaker: guardian-triggered pause, 72h auto-expiry, admin-gated early resume |
| `timelock` | `propose -> 24h delay -> execute` for risk-increasing admin actions |
| `risk-engine` | On-chain bounds-checker: reads real oracle status, pause status, and USDC balance; no deployment above NORMAL |

An off-chain keeper (`keeper/`) makes the decisions (burn forecasting,
oracle cross-checks, rebalance scheduling) that contracts only ever check
against a bound. This split keeps the audited on-chain surface small.
Its utilization monitor and XLM fee-floor swap trigger are real and
live-verified (see Testing); the Forecaster and reporter loops the PRD
also names are not started.

## Project structure

```
refluo/
  contracts/    the ten contracts above, plus common/ (shared types),
                mock-price-feed/ (real PriceFeedTrait impl, drill-only,
                not part of the product), and integration-tests/
                (cross-contract, dev-only)
  adr/          architecture decision records
  keeper/       off-chain loops: sentinel's utilization monitor and
                swap.ts's XLM fee-floor trigger are real and
                live-verified, swap.ts now submits through a real vault
                (adr/0016), Forecaster/reporter not started
  sdk/          TypeScript SDK for agent operators: the signing module
                (constructing and submitting a real multi-party vault
                authorization) is real and live-verified (adr/0016), the
                rest of the management-plane API is not started
  dashboard/    operator-facing web app (not started)
  drills/       scripted adversarial scenarios, some live (see Testing)
```

`sdk/`, `keeper/`, and `drills/` are npm workspaces sharing one root
`node_modules` (root `package.json`), not three separate installs.

## Quickstart

Requires Rust with the `wasm32v1-none` target and `stellar-cli` v27+,
needed for build too: `stellar-accounts`' `experimental_spec_shaking_v2`
feature only builds via `stellar contract build`, not plain `cargo build`.

```
git clone https://github.com/Majormaxx/refluo
cd refluo
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
stellar contract build --package refluo-vault   # omit --package to build all
```

## Testing

Unit and property tests (`proptest`) per contract, plus a live testnet
smoke test per contract that exercises the real deployed dependencies,
not mocks: `contracts/<name>/scripts/testnet_smoke_test.sh`.
`contracts/integration-tests` proves the composition unit tests can't,
including the self-rescue guarantee: an admin acting alone can strip
every policy from a vault with zero keeper or dashboard involvement.
`vault` and `policy-admin-threshold` were deployed live for the first
time, and the real 2-of-3 admin bootstrap was confirmed against that real
deployment, going beyond what an in-process simulation alone could show.
The multi-signer submission itself is now real too: `sdk/src/smartAccountAuth.ts`
constructs the nested authorization entries plain `stellar-cli` can't
(`adr/0008`'s gap), live-verified with a real 2-of-3 call, a real 1-of-3
rejection, a real 3-of-3 call, and the full self-rescue drill
(`drills/refluo_disappears_drill.mjs`): a real 2-of-3 call installs a
real policy, a second real 2-of-3 call removes it, confirmed gone from
both the vault's own bookkeeping and the policy's own storage (`adr/0016`).
`timelock` is the newest and thinnest on property-test coverage.
`oracle-router` and `policy-venue` also have real cargo-fuzz targets
(`contracts/oracle-router/fuzz`, `contracts/policy-venue/fuzz`), going
beyond property tests to fuzz the pricing math and the Blend `submit()`
decoder respectively against inputs no property test happened to pick.
`policy-venue`'s own `testnet_smoke_test.sh` goes further still: a real
Blend V2 testnet pool, not calldata this workspace assumed the shape of,
confirms Supply within cap allowed, Borrow and over-cap rejected, and a
real submit() call actually changing the real pool's recorded position
(`adr/0012`). `risk-engine`'s named `RiskProfile` presets
(Conservative/Balanced/Aggressive) are confirmed live to resolve their
real thresholds, not whatever values a caller's `TierConfig` happens to
carry (`adr/0013`). `policy-swap`'s slippage floor is checked against a
real cross-contract `OracleRouter` price read, not a caller-supplied
number: 18 unit/property tests plus a live `testnet_smoke_test.sh` that
authorizes a real `swap_exact_tokens_for_tokens` call against the real
Soroswap testnet router and confirms a real 5 USDC swap actually moves
real USDC out and real XLM in through the real live USDC/XLM pair
(`adr/0015`).
`keeper/`'s sentinel utilization monitor has 8 pure unit tests
(`npm test`, no network needed) plus a real testnet run: the real Blend
pool's organic utilization from other users, not a seeded number,
correctly escalated a real `risk-engine` deployment to Emergency
(`adr/0014`). `keeper/src/swap.ts`, the XLM fee-floor trigger, has 9
further pure unit tests plus a real testnet run of its own: an XLM
balance genuinely below the configured floor triggered a real signed
swap authorized through a real vault's own `r_swap` context rule (not a
plain funded identity, `adr/0016`), confirmed by real balance reads
before and after, and a second run once above the floor correctly took
no action (`adr/0015`, `adr/0016`).
`drills/yieldblox_drill.sh` runs a real 100x price spike against a real
deployed secondary feed live on testnet and confirms OracleRouter refuses
it, its own `check_and_trip` really pauses a real registered
HealthMonitor, not merely reporting the status (`adr/0010`), RiskEngine
blocks deployment, and the system recovers on its own once the feed
does. `drills/xlm_swap_sandwich_drill.sh` runs a real sandwich attack
against the real Soroswap pool: a real attacker front-run measurably
shifts the real pool's price, the victim's original zero-tolerance quote
then reverts for real against the real router, and a
production-realistic 97%-floor swap still succeeds once the pool is
restored (`adr/0015`). Don't infer coverage from a `#[cfg(test)]`
module existing, check what's actually asserted.

## Decisions & trade-offs

Design rationale, framework-source verification notes, and every real
bug found via live testnet deployment (not caught by mocks) are recorded
as ADRs in [`adr/`](adr/), one per decision worth a written record. Start
with [`adr/0001`](adr/0001-doctrine.md) for the core doctrine.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): fmt, clippy (`-D warnings`),
full test suite, then a per-contract `wasm32v1-none` release build under
a 64KB size budget. All required before merge.
