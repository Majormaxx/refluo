# vault

Thin wrapper on OpenZeppelin's `stellar-accounts` (pinned `v0.7.2`).
Implements `SmartAccount` and `CustomAccountInterface` with no
Refluo-specific auth logic. `__check_auth` is a one-line delegation to
`do_check_auth`, so the actual authorization decision lives entirely in
OZ's audited code, never in anything Refluo wrote. The framework's
context-rule/policy decomposition already gives Refluo the shape it needs
without adding custom logic on top. See `adr/0004` for corrections found
by verifying the framework's real source before writing this contract.

Every `SmartAccount` method is explicitly re-declared in `src/lib.rs`
(not left to the trait's defaults) — `#[contractimpl]` only exports methods
textually present in the impl block, confirmed by building with
`stellar contract build` and inspecting the exported-function list.

Deploy script responsibilities, not yet implemented (this is orchestration,
not contract code):

1. Deploy the vault with an admin context rule
   `simple_threshold(2, [you, cofounder, backup])`.
2. Install four context rules — `R_ADMIN`, `R_AGENT_PAY`, `R_YIELD`,
   `R_RECALL` — wired to the policy contracts in `../policy-venue`,
   `../policy-recall`, `../policy-session`. The wiring mechanism itself
   (`add_context_rule` cross-calling each policy's `install`) is verified
   in `../integration-tests`.
3. All auth entries signed with ADDRESS_V2 credentials. Never V1.

Scripts land here as `deploy.sh` / `deploy.ts` using `stellar-cli` once
that work starts.
