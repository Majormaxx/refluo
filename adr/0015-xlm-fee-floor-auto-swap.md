# ADR 0015: XLM fee-floor auto-swap via Soroswap, oracle-derived slippage floor

Status: accepted. Date: 2026-07.

## Decision

`contracts/policy-swap` is a new Policy contract closing the last open
Phase 3 gap: the Tier 0 fee-floor top-up path. It authorizes exactly one
thing, a capped, rate-limited swap from USDC into XLM through a single
allowlisted router, the same narrowness `policy-recall` already uses:
funds move only USDC to XLM, only to the vault itself, only through the
one allowlisted router, never anywhere else.

The router is Soroswap, not the Stellar classic DEX the PRD's "SDEX path"
language originally named. A Soroban contract's own address cannot
authorize a classic PathPayment operation the way a classic account can.
This was confirmed by reading Soroswap's real router interface, not
assumed from docs. Soroswap is a real, established Soroban-native AMM with a real
live testnet USDC/XLM pair, `router_pair_for` confirms it and
`get_reserves` shows real depth (roughly 444k USDC against 3.69M XLM at
verification time). The PRD's own wording is updated to name Soroswap
directly, so this substitution doesn't get silently lost or mistaken for
a shortcut later.

The part a compromised or buggy keeper key cannot fake is the slippage
floor. `enforce()` decodes a real
`swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to,
deadline)` call (arg order confirmed live via `stellar contract info
interface` against the deployed router, not assumed from docs), checks
`path` is exactly `[token_in, token_out]` with no multi-hop, checks `to`
equals the vault, checks `amount_in` against a per-call and epoch cap
identical in shape to `policy-venue`'s, checks `deadline` falls within a
configured window, and computes its own floor for `amount_out_min` from a
real cross-contract read of `OracleRouter`'s live price, the same mirror
pattern `risk-engine` already uses for its own oracle read (`adr/0006`).
A caller-supplied `amount_out_min` below that floor is rejected outright,
regardless of what the caller claims the swap is worth.

`keeper/src/swapDecision.ts` and `keeper/src/swap.ts` close the
monitoring and execution half. `swapDecision.ts` is pure, no network, no
signing, mirrors the same oracle-floor formula the contract enforces so
the loop never proposes something the contract would reject.
`swap.ts` reads a real XLM balance, a real live `OracleRouter` price, and
a real Soroswap router quote before submitting, and when the balance is
below the configured floor it submits a real, signed
`swap_exact_tokens_for_tokens` transaction.

`drills/xlm_swap_sandwich_drill.sh` is the adversarial rehearsal. Two
real halves: `policy-swap.enforce()` rejects a sandwich-shaped near-zero
`amount_out_min` outright, and separately, a real attacker front-run
executed live against the real Soroswap pool measurably shifts its real
reserves, after which the exact same victim swap, submitted with its
pre-manipulation zero-tolerance quote, reverts for real against the real
router, and a production-realistic 97%-floor swap still succeeds once the
pool is restored. The floor blocks a genuine attack without breaking on
ordinary market movement, demonstrated against real infrastructure, not
asserted from a unit test alone.

## Why

Every other policy contract in this workspace derives its safety property
from real on-chain data it reads itself, never from what a caller
submits: `policy-venue` and `policy-recall` decode real Blend calldata,
`risk-engine` reads real oracle and pause status. A swap policy that
accepted the caller's own `amount_out_min` at face value would break that
pattern for the one action that moves funds through an external AMM,
exactly where a wrong or compromised number does the most damage. The
oracle-derived floor keeps the same invariant: the contract's own
cross-contract read is the source of truth, not the transaction's own
arguments.

The keeper side of this hits the same SDK signing gap `adr/0008` already
found, not a new one. Submitting `swap_exact_tokens_for_tokens` with the
real `vault` (a `stellar-accounts` `CustomAccountInterface`) as the
funding side needs a hand-built `AuthPayload` for the vault's own
authorization entry, `context_rule_ids` plus a signer map, a structure no
plain `stellar-cli` signing flow understands regardless of how many
signers a given context rule names. `adr/0008` already scoped that
capability to the SDK's signing module, not a one-off script, and that
scoping applies here without change. What's real and complete today:
`swap.ts` runs the full monitor-decide-quote-submit pipeline live against
this keeper's own funded testnet identity, balance below floor correctly
triggers a real signed swap, balance at or above floor correctly does
nothing on the next tick, both confirmed against real transaction
results, not simulated. Once the SDK's signing module exists, pointing
`ACCOUNT` at the real vault is the only change this loop needs.

## Consequences

- `policy-swap`'s config carries `token_in_decimals`/`token_out_decimals`
  cached at install time from each token's own real `decimals()` call,
  not re-read on every `enforce()`. Both are 7 on testnet today (verified
  live), the formula does not assume they match.
- `keeper/packages/token-client`, `soroswap-router-client`, and
  `oracle-router-client` are generated, checked-in bindings, same
  convention `risk-engine-client` already established. `token-client` is
  generated from the real USDC contract's spec; its balance/decimals
  calls are structurally standard across any real Stellar SAC token,
  confirmed by using the same generated class against the native XLM SAC.
- The real `xlm_swap_sandwich_drill.sh` run moves real testnet funds
  (a front-run leg followed by a restoring back-run), it is not free to
  re-run arbitrarily often, unlike a pure read-only smoke test.
- `keeper/src/swap.ts` targeting the real `vault` instead of a plain
  funded identity remains blocked on the same SDK signing module
  `adr/0008` already deferred, tracked there, not duplicated here.
