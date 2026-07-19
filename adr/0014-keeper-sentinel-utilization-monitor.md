# ADR 0014: A real sentinel loop closes Phase 3's utilization monitor gap

Status: accepted. Date: 2026-07.

## Decision

`keeper/` now has a real, working sentinel loop
(`keeper/src/sentinel.ts`), the "utilization monitor" Phase 3 of the
internal roadmap names, scoped to exactly that: reading real Blend V2
reserve utilization and attesting it to `RiskEngine`. The Forecaster and
reporter loops the PRD's keeper architecture also names stay unbuilt,
this ADR closes one specific gap, not the whole keeper.

TypeScript, using `@blend-capital/blend-sdk` (the official Blend SDK,
`PoolV2.load()` then `reserve.getUtilization()`, not a hand-rolled RPC
call against the pool's raw ledger entries) and generated TS bindings
for `risk-engine` (`stellar contract bindings typescript`, official
Soroban CLI tooling, checked into `keeper/packages/risk-engine-client`).
TypeScript because the PRD's own project structure already commits to it
for `sdk/`, and a keeper that submits signed transactions needs
essentially the same transaction-building machinery the SDK will, this
isn't a fresh architecture decision, it's following what the workspace
already declared.

Decision logic is escalation-only and lives in a separate pure module
(`keeper/src/decision.ts`), 8 unit tests, no network or signing
dependency, run via `npm test`. Utilization at or above
`full_drain_util_bps` escalates straight to Emergency; at or above
`preemptive_util_bps` escalates to PreemptiveDrain; anything below
either, or a state that's already at or past the relevant target, does
nothing. Recovery (bringing `SystemState` back down) is never attempted
by this loop, that stays the deliberate, separately-verified
`keeper_advance_state` downward path `adr/0006` already covers.

Live-verified on testnet, going beyond the unit tests: pointed at the same real
Blend V2 pool `adr/0012` verified, against a fresh `risk-engine`
deployment with deliberately low thresholds (1%/2%) so the pool's real,
organic utilization from other testnet users (85.55% at the time of the
run, not a number this workspace controlled or seeded) would trigger a
genuine escalation. It did: `keeper_advance_state` submitted a real
signed transaction, `RiskEngine`'s on-chain state read back afterward
showed `Emergency`, and a second run correctly took no action once
already there.

## Why

A "utilization monitor" that only knows how to read numbers this
workspace fabricated for it would prove the on-chain accept-a-number
path works, already covered by `risk-engine`'s own tests and ADRs, but
say nothing about whether this workspace's understanding of Blend's real
utilization computation is correct, decimals, fixed-point scaling, which
Pool class version matches a real deployed pool's real schema. The one
genuine bug this surfaced: `@blend-capital/blend-sdk`'s `^2.0.0` range
resolved to a version whose `PoolConfig` parser rejected the real
deployed pool's `min_collateral` field, a real schema mismatch between
SDK major version and the pool's real contract version, not a keeper
bug. Pinning `3.3.0` and switching from a generic `Pool` class to the
version-specific `PoolV2` (the real v3 SDK splits pool classes by
protocol version) fixed it. Found by running against the real pool and
reading the real error, not by trusting the SDK's semver range.

## Consequences

- `keeper/.env` (a real secret key) is gitignored; `.env.example`
  documents every variable needed to run this against testnet.
- `keeper/packages/risk-engine-client` is generated, checked-in source,
  not hand-written; regenerate it with
  `stellar contract bindings typescript --wasm <risk-engine wasm> --output-dir keeper/packages/risk-engine-client --network testnet --overwrite`
  whenever `risk-engine`'s interface changes, then `npm install && npm run build`
  inside that directory.
- The sentinel currently monitors one hardcoded reserve
  (`RESERVE_ASSET_ID`) against one `risk-engine` account (`ACCOUNT`). A
  vault with multiple Tier 1 positions across several reserves, or
  multiple vaults sharing one keeper process, needs this generalized
  before it's the real production loop, not a limitation this ADR hides.
