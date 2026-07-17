# ADR 0001: Core doctrine

Status: accepted. Date: 2026-07.

## Decision

1. Refluo is a liveness engine, not a wallet. The invariant that matters:
   the agent's Tier 0 buffer never drops below P99 burn over the
   recall-latency window. Every contract and the keeper exist to serve that
   invariant.
2. On-chain contracts enforce bounds (caps, allowlists, rate limits,
   staleness). Off-chain keepers decide (forecasting, oracle cross-checks,
   rebalance scheduling). Prediction math never goes on-chain.
3. Every privileged path is bounded, revocable, observable. No unbounded
   admin power, no permanent grants, events on every state change.
4. Build on OpenZeppelin's `stellar-accounts` (pinned `v0.7.2`) rather than
   hand-rolling `__check_auth`. Its context-rule/policy decomposition
   already matches the shape Refluo needs.
5. ADDRESS_V2 credentials throughout, as the direction of travel — not
   because a mandatory deprecation date for V1 is confirmed. CAP-71 is
   currently opt-in as of Protocol 27; no CAP or SDF announcement commits
   Protocol 28 to making it mandatory. Re-check this each protocol cycle.

## Why

Full rationale in `refluo-prd-unified.md` §0 and §5 (local, not committed —
see the repo's `.gitignore`). This ADR exists so the doctrine survives even
if that document is ever lost, without reproducing its business content.

## Consequences

- Any PR introducing on-chain market analysis, unbounded admin functions,
  or code that hard-assumes ADDRESS_V1-only payloads should be rejected in
  review as a doctrine violation, not just a style nit.
- New contracts default to the OZ Policy trait lifecycle
  (`install`/`can_enforce`/`enforce`/`uninstall`) unless there's a specific
  documented reason not to.
