# ADR 0011: A second, higher utilization threshold reaches Emergency directly

Status: accepted. Date: 2026-07.

## Decision

`TierConfig` gained `full_drain_util_bps`, a second keeper-attested
utilization threshold above `preemptive_util_bps`, checked at `init()` to
be strictly greater. `keeper_advance_state`'s utilization-driven path now
handles both targets: attesting utilization at or above
`preemptive_util_bps` still only justifies `PreemptiveDrain`; attesting at
or above `full_drain_util_bps` justifies `Emergency` directly, reachable
from any state below it, not only by passing through `PreemptiveDrain`
first. A vault whose Blend reserve utilization spikes past the full-drain
line doesn't need two separate keeper calls to reach the state that
matters.

Live-verified on testnet via `contracts/risk-engine/scripts/testnet_smoke_test.sh`:
90% utilization (between the two thresholds) correctly rejected for an
Emergency claim, then correctly accepted for PreemptiveDrain; 95%
utilization correctly moves straight to Emergency.

## Why

Before this, `RiskEngine` had exactly one utilization-driven escalation
path. A vault sitting at 95% Blend utilization with a healthy oracle and
a funded balance had no way to reach Emergency at all, `check_and_trip`'s
only Emergency triggers are a degraded oracle or a low on-chain balance,
neither of which utilization is. The bounds-checker's own guarantee,
never deploy above NORMAL, held, but nothing forced an already-deployed
position toward the most conservative state when the actual risk
condition (a pool close to being unable to honor withdrawals) was
present. Two separate thresholds, not one raised threshold, because
preemptive draining ahead of a liquidity crunch and a full stop once one
is likely underway are different responses this workspace's own tiering
model already names separately.

## Consequences

- Existing `TierConfig` literals (tests, deployment scripts) all needed
  `full_drain_util_bps` added; none of them previously encoded any
  full-drain policy; 9200 (92%) matches the PRD's own number, not a
  guess.
- `deploy_allowed` is unaffected: it already returns `false` for anything
  but `Normal`, so this ADR closes a real escalation gap, not a
  bounds-checking one.
