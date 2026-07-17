# ADR 0001: Core doctrine

Status: accepted. Date: 2026-07.

## Decision

1. Every contract in this repo exists to keep one number true: the agent's
   hot-spend buffer covers its own P99 burn rate over however long a
   recall actually takes. That's the thing that actually gets tested and
   defended, not any individual contract's feature list.
2. Keep judgment calls off-chain and bounds checks on-chain. A keeper
   forecasts burn and cross-checks price feeds; the contracts it talks to
   only ever compare a submitted number against a stored limit. Nothing
   that requires weighing evidence runs in a contract.
3. Every privileged path is bounded, revocable, observable: no admin power
   without a limit, no grant that can't be revoked, an event on every
   state change worth knowing about.
4. Build on OpenZeppelin's `stellar-accounts` (pinned `v0.7.2`) rather than
   hand-rolling `__check_auth`. Its context-rule/policy decomposition
   already matches the shape Refluo needs.
5. ADDRESS_V2 credentials throughout, as the direction of travel, not
   because a mandatory deprecation date for V1 is confirmed. CAP-71 is
   currently opt-in as of Protocol 27; no CAP or SDF announcement commits
   Protocol 28 to making it mandatory. Re-check this each protocol cycle.

## Why

Full rationale is tracked in an internal design document, not committed to
this repo. This ADR exists so the doctrine survives independently of that
document, without reproducing its business content.

## Consequences

- Any PR introducing on-chain market analysis, unbounded admin functions,
  or code that hard-assumes ADDRESS_V1-only payloads should be rejected in
  review as a doctrine violation, not just a style nit.
- New contracts default to the OZ Policy trait lifecycle
  (`install`/`enforce`/`uninstall` — verified against source in adr/0004,
  no `can_enforce` method exists) unless there's a specific documented
  reason not to.
