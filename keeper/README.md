# keeper

Off-chain binary, three loops in the full architecture: Forecaster
(5min), sentinel (1min), reporter (1h). Full loop spec tracked
internally, not in this repo.

The sentinel's utilization-monitoring half is real and working
(`src/sentinel.ts`): reads a real Blend V2 pool's reserve utilization via
the official `@blend-capital/blend-sdk`, and when it crosses
`risk-engine`'s own configured thresholds, attests it on-chain via a real
`keeper_advance_state` call. Escalation only, deliberately, recovery
stays a separate decision. See `adr/0014`.

The XLM fee-floor swap trigger is also real and working (`src/swap.ts`):
reads a real XLM balance and a real `OracleRouter` price, and once the
balance drops below a configured floor, submits a real, oracle-floor-
bounded swap through the real Soroswap testnet router, sanity-checked
against a real live router quote first. Submission goes through the real
`vault` contract, not a plain funded identity: `VAULT_ADDRESS` needs an
installed context rule (`SWAP_CONTEXT_RULE_ID`) naming this keeper's own
address as a delegated signer with `policy-swap` attached, a session
scope distinct from `R_ADMIN`. Live-verified end to end: a real
below-floor balance on a real vault triggered a real swap authorized
through that vault's own context rule, confirmed by real balance reads on
the vault before and after. See `adr/0015` for the swap mechanism,
`adr/0016` for the vault-authorized submission (the SDK's real signing
module, `sdk/src/smartAccountAuth.ts`).

The Forecaster's Tier 0 sizing half is also real and working
(`src/forecaster.ts` for the pure EWMA/hysteresis model,
`src/forecasterLoop.ts` for the real integration): reads real USDC
transfer events out of the vault via the RPC, winsorizes and runs them
through fast (6h) and slow (7d) burn-rate EWMAs, and writes a real
`risk-engine.set_tier0_target` call when the proposed target diverges
from the on-chain value by more than a configured band. Live-verified: a
real deployed `risk-engine` received a real `set_tier0_target` write with
`SUCCESS` status. See `adr/0017`, which also covers a real finding: the
live USDC token's transfer event carries four topics, not the three a
generic SEP-41 assumption expects. The recall-triggering half reuses
`adr/0016`'s signing mechanism and is real code, not yet live-verified on
its own (needs a real Blend position deployed first).

The Reflector Subscriptions webhook pipeline is also real and working
(`src/reflectorSubscription.ts` for signature verification and RedStone
cross-checking, `src/reflectorQuorum.ts` for trust accumulation across
distinct verifier keys, `src/reflectorWebhookServer.ts` for the real HTTP
receiver, `src/reflectorSubscriptionManager.ts` for real on-chain
subscription create/deposit/cancel via `@reflector/subscription-client`):
a real quorum of distinct trusted Reflector verifier signatures, each
checked against the real signing scheme reflector-node's own source uses,
is required before a pushed price is cross-checked against a real
RedStone REST quote, and a confirmed divergence pauses a real deployed
`health-monitor` through its own guardian primitive. Live-verified
end to end except the notification's real origin: no real testnet
deployment of Reflector's own Subscriptions contract was discoverable, so
`scripts/reflector_webhook_smoke_test.mjs` POSTs real-crypto,
correctly-shaped synthetic notifications (two throwaway keys standing in
for real node keys) at the real running server, which really fetched a
live RedStone price and really paused a real freshly deployed
`HealthMonitor`, confirmed by a real `status()` read before and after.
See `adr/0018` for the disclosed gap and every other real finding.

The reporter loop is also real and working (`src/reporter.ts` for the
pure metric computation, `src/reporterLoop.ts` for the real integration):
Tier 0 hit rate and recall latency come from a real local metrics log
`forecasterLoop.ts` now writes to on every tick and every real recall,
pause count/duration comes straight from `health-monitor`'s own real
emitted events (its exact topic/value shape confirmed live, not assumed
from source), and Forecaster error backtests the sizing model against
real chain history it never got to see in advance. Live-verified: a real
paused/resumed `HealthMonitor` cycle was correctly reconstructed from
chain alone, and seeded real metric-log events came back through a real
`tick()` with exactly the expected hit rate and latency (`adr/0019`). No
dashboard exists yet to display it (separately tracked); `tick()` writes
the real computed snapshot to a local JSON file in the meantime.

## Setup

```
npm install
cp .env.example .env   # fill in KEEPER_SECRET, RISK_ENGINE_ID, ACCOUNT,
                        # VAULT_ADDRESS, SWAP_CONTEXT_RULE_ID
npm test                # pure decision-logic tests, no network needed
npm run sentinel:once   # one real utilization-monitor tick against testnet
npm run sentinel        # continuous utilization-monitor loop
npm run swap-sentinel:once   # one real XLM fee-floor tick against testnet
npm run swap-sentinel        # continuous XLM fee-floor loop
npm run forecaster:once      # one real Tier 0 sizing tick against testnet
npm run forecaster           # continuous Tier 0 sizing loop
npm run reflector-webhook    # real webhook server (needs HEALTH_MONITOR_ID,
                              # REFLECTOR_TRUSTED_VERIFIERS)
npx tsx scripts/reflector_webhook_smoke_test.mjs   # real end-to-end webhook
                                                    # + quorum + pause drill
npm run reporter:once        # one real SLA telemetry tick against testnet
npm run reporter             # continuous reporter loop
npx tsx scripts/reporter_smoke_test.mjs   # real pause/resume + metrics-log
                                           # + backtest drill
```

`keeper/packages/risk-engine-client`, `oracle-router-client`,
`token-client`, and `soroswap-router-client` are generated by `stellar
contract bindings typescript`, not hand-written. Regenerate a
Refluo-owned contract's client whenever its interface changes:

```
stellar contract bindings typescript \
  --wasm ../target/wasm32v1-none/release/refluo_risk_engine.wasm \
  --output-dir packages/risk-engine-client --network testnet --overwrite
cd packages/risk-engine-client && npm install && npm run build
```

`token-client` and `soroswap-router-client` were generated directly from
the real deployed contract ids (`--contract-id`, no local wasm needed)
since Refluo doesn't own those contracts:

```
stellar contract bindings typescript \
  --contract-id <real USDC or Soroswap router contract id> \
  --network testnet --output-dir packages/<name> --overwrite
```
