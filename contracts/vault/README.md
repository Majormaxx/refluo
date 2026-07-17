# vault

Not a contract Refluo owns — a deployment recipe on top of OpenZeppelin's
`stellar-accounts` (pinned `v0.7.2`). See `refluo-prd-unified.md` §2 (local,
not in this repo) for why: hand-rolling `__check_auth` is how solo devs die,
and the framework's context-rule/policy decomposition already gives Refluo
exactly the shape it needs.

Deploy script responsibilities (Phase 1, not yet implemented):

1. Deploy an OZ smart account with admin context rule
   `simple_threshold(2, [you, cofounder, backup])`.
2. Install four context rules — `R_ADMIN`, `R_AGENT_PAY`, `R_YIELD`,
   `R_RECALL` — wired to the policy contracts in `../policy-venue`,
   `../policy-recall`, `../policy-session`.
3. All auth entries signed with ADDRESS_V2 credentials. Never V1.

Scripts land here as `deploy.sh` / `deploy.ts` using `stellar-cli` once
Phase 1 starts. Exact OZ constructor/helper names must be re-verified
against the pinned `stellar-accounts` version at that time — the framework's
surface has moved between minor versions before.
