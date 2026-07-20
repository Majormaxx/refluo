# ADR 0017: Forecaster Tier 0 sizing, real burn ingestion, and the recall griefing bound

Status: accepted. Date: 2026-07.

## Decision

`keeper/src/forecaster.ts` is the pure sizing model (`implementation-spec`
§9's own formula, restated here in this workspace's own words): two
EWMA burn-rate estimates over winsorized hourly observations, a fast one
(6h half-life) and a slow one (7d half-life), combined into

```
target = max(fast, slow) * recall_window * k + xlm_fee_floor_usd
```

`k` is an operator-set buffer multiplier over the raw estimate, kept as a
plain keeper config value, not a fixed per-risk-profile constant.
Tier 0 sizing runs entirely off-chain; `risk-engine`'s own
`tier0_bounds_min`/`max` remain the real on-chain safety net no matter
what the Forecaster proposes, so there is no on-chain-verifiability
argument for hardcoding `k` the way `RiskProfile`'s utilization
thresholds are hardcoded (`adr/0013`). `xlm_fee_floor_usd` is a
USDC-equivalent buffer, not an XLM amount: it is what lets Tier 0 absorb
a real XLM fee-floor top-up (`adr/0015`) without the balance itself
dipping below its own minimum.

Asymmetric hysteresis matches the spec exactly: a higher computed target
applies immediately, a lower one only applies once it has stayed below
the current on-chain value for a full 24 hours, tracked in a small local
state file between ticks (the only piece of state that genuinely can't
be recomputed fresh each tick, everything else is recomputed from real
chain data every run, see below).

`keeper/src/forecasterLoop.ts` is the real integration: it queries the
RPC for real USDC transfer events out of the vault, aggregates them into
hourly buckets, runs the sizing model, and writes a real
`risk-engine.set_tier0_target` call when the proposed value diverges from
the on-chain value by more than a configured band. It also computes a
real recall trigger (`shouldRecall`) and, when a venue and context rule
are configured, submits a real `RecallExecutor` withdraw through the
vault using the same `authorizeAndSendSmartAccountCall` mechanism
`adr/0016` already proved live for the swap keeper.

## Two real findings from building this against real chain data

**RPC event retention matches the model's own window.** Live testnet
runs show the public RPC retains roughly 121,000 ledgers of event
history, about 7 days at Stellar's real ~5 second ledger close time.
That is not a coincidence this workspace had to work around, it is
exactly the trailing window `winsorize()` and the slow EWMA both want.
Rather than persist an incremental EWMA across ticks, which would
silently drift from what the chain can actually still prove, this loop
recomputes both EWMAs from scratch every tick by replaying whatever
history the RPC still has.

**The real USDC transfer event carries four topics, not three.** A
generic SEP-41 assumption expects `[transfer, from, to]` with the amount
as the event's data payload. Reading real emitted events from this
workspace's own testnet activity shows a fourth topic, an asset-code
string (`"USDC:GBBD47IF...ZLLFLA5"`), appended after `to`. A three-topic
filter matches nothing against the real deployed contract, confirmed by
querying with no topic filter at all and inspecting what came back. The
real filter needs a trailing wildcard for that fourth position.

## The recall griefing bound

Phase 4's task list names "Forecaster griefing defenses" as a
deliverable. The mechanism this bounds already exists and was already
property-tested (`policy-recall`, `adr/0001`-era work): a compromised
recall key can never move funds anywhere but the vault itself
(`prop_destination_always_equals_vault`), and `check_and_bump_rate_limit`
caps how many recalls land within any rolling window. What a compromised
key can do is force a real de-yield: pull capital out of Tier 1 back
into the zero-yield Tier 0 buffer, faster or more often than an operator
intended, never steal it or redirect it. There is no per-call amount cap
on a single recall (rate limiting is the only lever `policy-recall`
exposes, an operator sizing a real `RecallConfig` controls the actual
bound by how many recalls it permits per window, not by a fixed number
this workspace can quote without knowing the operator's own real
parameters).

The real, provable bound: at most one full de-yield of whatever capital
is deployed to Tier 1 at the moment of compromise, recoverable the
instant an admin revokes the compromised key (`R_ADMIN`, always intact
independent of any single agent or keeper key) and re-deploys. This is a
foregone-yield cost bounded by (deployed Tier 1 capital) x (real yield
rate) x (real time to detection and revocation), not a bps/day figure
this workspace can state without an operator's real numbers for both.
The `implementation spec`'s incident-response SLA (acknowledge within 15
minutes) is the real lever that keeps the detection-time term small.

## Consequences

- `forecasterLoop.ts`'s real recall trigger needs `RECALL_CONTEXT_RULE_ID`
  and `RECALL_VENUE_ID` configured to ever fire; left unset, the loop
  still sizes Tier 0 and writes real `set_tier0_target` calls, it simply
  never attempts a recall. Live-verifying the recall trigger specifically
  needs a real Blend position deployed through `policy-venue` first (the
  same real-infrastructure bar every other live check in this workspace
  holds itself to), not yet exercised in this pass; the code path reuses
  the exact signing mechanism already proven live for the swap keeper.
- `k` and `xlm_fee_floor_usd` are real keeper config today, not resolved
  from any on-chain source. A future dashboard surfacing risk-profile
  presets for these values is an SDK/dashboard concern, the same
  boundary `adr/0013` already drew for utilization thresholds, just on
  the other side of it this time, since these particular numbers have no
  on-chain-verifiability argument for living in a contract.
- The four-topic event filter is specific to the real Circle-issued USDC
  test token this workspace targets. A different SAC token's transfer
  event shape should be confirmed the same way, by reading a real emitted
  event, before assuming the filter transfers unchanged.
