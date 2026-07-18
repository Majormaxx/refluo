# ADR 0006: RiskEngine isolated on soroban-sdk 25.3, real cross-contract integrations only

Status: accepted. Date: 2026-07.

## Decision

`contracts/risk-engine` follows the same isolation pattern as `oracle-router`
(`adr/0005`): its own `soroban-sdk ~25.3`, no dependency on `refluo-common`,
local mirrors of the shared types it needs. It doesn't need
`stellar-accounts` any more than `oracle-router` did, and it needs to share
`sep-40-oracle`'s `Asset` type directly with `oracle-router` to call
`get_price()`, so pinning the same version as `oracle-router` is a real
constraint, not a stylistic choice.

Every external fact `advance_state()` checks is read from a real contract,
not attested by a caller and trusted blindly, except the one place the
architecture always intended that (see below):

- Oracle status (`OneFeed`, `Degraded`) is read via a real cross-contract
  call to `OracleRouterClient::get_price()`, the same client
  `oracle-router`'s own tests use.
- Pause status is read via a real cross-contract call to
  `HealthMonitorClient::status()`.
- The critical-floor check (`tier0 < critical_floor` for the Emergency
  transition) reads the vault's actual on-chain USDC balance via
  `soroban_sdk::token::TokenClient::balance()`, the real SEP-41 balance of
  the real token contract, not a number anyone reports.
- Venue utilization for the `PreemptiveDrain` trigger remains
  keeper-attested (an explicit `u32` argument to `advance_state`), because
  utilization genuinely is off-chain data (Blend reserve state read via
  RPC). This was always the documented design, not a shortcut. The
  on-chain guarantee that matters is unaffected: RiskEngine still proves
  on-chain that nothing deploys above NORMAL, provable from data it reads
  itself.

## Why

The "no stubs" rule (global, `~/.claude/CLAUDE.md`) exists because of what
`oracle-router` already proved this session: a mock built from the same
assumption as the code it tests can't falsify that assumption. Trusting a
caller-supplied "oracle status" or "vault balance" argument in
`advance_state()` would make the whole state machine a stub wearing a real
interface. It would pass every unit test and mean nothing on a live
network, since nothing would stop an admin (or a bug) from claiming Healthy
while the oracle was actually Degraded.

`HealthMonitor.pause()` and `resume_early()` didn't exist before this,
only the lazy `status()` read did. Without a way to actually set
`PauseState`, RiskEngine's `Paused` transition would be a real cross-contract
call to a function that can only ever return `false`: correct code, but an
untestable, unverifiable path, which is close enough to a stub in spirit
that it gets the same fix. Both are now implemented (guardian-gated pause,
72h auto-expiry, admin-gated early resume), the minimum needed to make the
Paused transition genuinely exercisable, not the full HealthMonitor
(`extend()`, `tick_recovery()`, `check_and_trip()` remain unbuilt and
explicitly stated as such, not stubbed).

## Consequences

- `risk-engine` requires `oracle_router`, `health_monitor`, and `usdc_token`
  addresses at `init()` time; it cannot function against placeholder
  addresses, by design.
- Testing `advance_state()` for real requires mock `OracleRouter` and
  `HealthMonitor` contracts in unit tests (matching the pattern already
  used for `oracle-router`'s own mock price feeds) plus a live testnet
  deployment wired to the real, already-deployed `oracle-router` and a real
  testnet USDC SAC, verified end to end, not asserted.
- Utilization stays keeper-attested. This is not a "stub except for this
  one part" exception. It's the documented boundary between what's
  provable on-chain (bounds) and what's inherently off-chain (Blend
  reserve state), the same on-chain-enforces/off-chain-decides split every
  other contract in this workspace follows.

## Addendum: two bugs the unit suite caught, one only live deployment could

Writing `check_and_trip`'s and `keeper_advance_state`'s tests surfaced two
real defects before anything touched testnet, both possible only because
the balance check calls a real Stellar Asset Contract test double
(`register_stellar_asset_contract_v2` + `StellarAssetClient::mint`), not a
hand-rolled mock that would have shared the code's own assumptions:

- A test asserting the OneFeed-to-PreemptiveDrain transition left the test
  account unfunded, so the real balance check correctly forced Emergency
  first and masked the intended assertion. A test bug, not a contract bug,
  but the real check is what caught it.
- `keeper_advance_state`'s recovery path checked oracle health for
  downward transitions but never re-verified the balance condition that
  could independently justify staying in a more severe state. Fixed by
  requiring every condition that could justify the target state to clear,
  including ones a different trigger tripped. A dedicated regression test
  locks this in.

Live testnet deployment then surfaced a third finding neither test double
could have: the real testnet USDC SAC
(`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`) wraps a
classic Stellar asset issued by Circle, and `balance()` on a
classic-wrapped SAC traps with "trustline entry is missing" for any
account that has never established one; it never returns zero. Every
unit test's token double is a native contract asset with no trustline
concept, so this path was structurally invisible until a real call hit a
real classic-backed SAC. The fix is operational, not a code change: any
account holding USDC needs a trustline to hold it at all, so establishing
one is a real precondition, not a workaround, and
`contracts/risk-engine/scripts/testnet_smoke_test.sh` does it before
every run.

Every `SystemState` transition and every rejection path was then driven
end to end on testnet against the real deployed `oracle-router`, a real
`health-monitor` pause/resume, and the real USDC balance read: `check_and_trip`
tripping Emergency on a genuine zero balance, escalating to Paused on a
genuine guardian pause, `keeper_advance_state` rejecting a recovery
attempt while the real balance was still under the floor, rejecting a
utilization attestation under threshold, rejecting a non-keeper caller,
and succeeding into PreemptiveDrain on a qualifying utilization
attestation. The one path not exercised live is recovery to Normal on a
sufficient real balance: Circle's testnet USDC faucet is
browser/captcha-gated, not scriptable, so that path stays verified
against the real Stellar Asset Contract test double in the unit suite;
Circle's own issuer is out of reach for an automated run. Every other
real-infrastructure integration point in this contract has been proven
live, not asserted.
