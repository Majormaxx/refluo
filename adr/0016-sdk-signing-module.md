# ADR 0016: the SDK's signing module, closing the stellar-cli gap for real

Status: accepted. Date: 2026-07.

## Decision

`sdk/src/smartAccountAuth.ts` is a real, working implementation of the
capability `adr/0008` found missing: constructing and submitting a real
multi-party-authorized transaction through a `stellar-accounts`
`SmartAccount`/`CustomAccountInterface` vault. `authorizeAndSendSmartAccountCall`
takes an unsigned transaction targeting any contract the vault authorizes
funds for, a context rule id, and the real co-signer keypairs, and returns
the landed transaction result or throws on a genuine on-chain rejection.

The approach, confirmed live against real deployed vaults:

1. Simulate the target call with the vault's auth entry still empty, to
   learn that entry's freshly assigned nonce.
2. Build the vault's own custom `AuthPayload` by hand (`context_rule_ids`
   plus a `signers` map, `stellar-accounts`' own struct, no standard
   signing convention covers it) and one real, individually-signed
   synthetic entry per co-signer for the `require_auth_for_args` call
   `stellar-accounts`' `authenticate()` makes internally.
3. Re-simulate with those real, non-void entries attached. Only once the
   auth is real does the host actually execute `__check_auth` and every
   cross-call it triggers, so this second simulation's footprint and
   instruction budget come back correctly discovered, not manually padded
   against a first simulation that never really ran the check.
4. Assemble the final transaction from that second simulation
   (`assembleTransaction` preserves auth entries already present on the
   operation instead of overwriting them) and sign the envelope with the
   fee-paying source.

Two real findings shaped the encoding, both confirmed by reading the
host's actual rejection, not guessed from docs: `stellar-accounts`' own
`Map<Signer, Bytes>` orders its entries by raw ScVal byte comparison, not
string or insertion order, a real 2-of-3 call decoded incorrectly until
this was fixed; and a `Signer::Delegated`'s authentication is a
synthetic `SorobanAuthorizedInvocation` shaped
`{contract: vault, function_name: "__check_auth", args: [auth_digest]}`,
not tied to the calling function's own real arguments.

A third finding came from the swap path specifically: `context_rule_ids`
does not always have exactly one element. Soroswap's real router calls
`require_auth()` on the funding address twice within one transaction,
once for `swap_exact_tokens_for_tokens` itself and again for its internal
`token_in.transfer()`, and the host batches every such requirement for
one address into a single entry passed to one `__check_auth` call. The
module now counts nodes in the vault entry's own invocation tree (root
plus every subInvocation, recursively) instead of assuming a fixed
length of one, confirmed against both shapes: single-context admin calls
and Soroswap's real two-context swap.

Live-verified, all against real deployed contracts, not testutils:

- A real 2-of-3 call against a fresh vault authorized and landed; a real
  1-of-3 attempt was rejected by the real threshold policy; a real 3-of-3
  call (beyond the minimum) also succeeded.
- The "Refluo disappears" self-rescue drill end to end: a real 2-of-3
  call installed a real `policy-venue` rule, a second real 2-of-3 call
  removed it, and `policy-venue`'s own per-rule storage was confirmed
  gone afterward, beyond just the vault's rule bookkeeping. Closes the
  last open piece of Phase 1.
- `keeper/src/swap.ts` now submits through a real vault instead of a
  funded EOA: a real XLM balance below the configured floor triggered a
  real signed swap authorized by the vault's own `r_swap` context rule,
  confirmed by real balance reads before and after (USDC decreased,
  XLM increased, matching the router's own quote). Closes the last open
  piece of Phase 3.

## A real bug this surfaced in `policy-swap`

The two-context discovery above forced `policy-swap`'s own `enforce()` to
handle a second `Context` it had never seen before: the router's internal
`token_in.transfer(vault, pair, amount)`. The first attempt at handling it
called `router_pair_for` live, from inside `enforce()`, to verify the
transfer's destination was Soroswap's real registered pair. That call
failed for real: the host's own reentrancy guard forbids a contract from
calling back into an address that is already executing on the current
call stack, and `router` is exactly that address here, this specific
`enforce()` invocation is happening because `router` itself is mid-call.

The fix resolves and caches the real pair address once, in `install()`,
where no reentrancy issue exists, and `enforce()`'s transfer-context arm
reads that cached value instead of calling out live. This fixes more
than the reentrancy error. Before this fix, the naive
alternative (accept any `token_in` transfer from the vault up to
`per_call_cap`, with no destination check at all) would have let an
attacker submit that context alone, with no paired swap call, and
authorize an arbitrary-destination transfer of the vault's `token_in`,
completely bypassing the router. This was found and fixed only because
this was verified against the real router live, never testutils, no
mock ever independently reproduced the router's own real double-auth
requirement to expose it.

## Why the module stays this narrow

`sdk/`'s full surface (§8.1: `createVault`, agent key management, webhook
events, the whole management-plane API) is a separate, much larger
undertaking, arguably its own product, not what closes the two drills
this ADR was scoped to unblock. `authorizeAndSendSmartAccountCall` is
the one piece both of them were actually waiting on. Building the rest of
`sdk/` before this piece existed and was proven live would have meant
guessing at an API shape for a signing capability nobody had verified
worked yet.

## Consequences

- `sdk/`, `keeper/`, and `drills/` are now real npm workspaces (root
  `package.json`), not three independently-installed packages. A real
  bug forced this: `drills/` and `sdk/` each installing their own copy of
  `@stellar/stellar-sdk` meant a `Transaction` built in one failed
  `instanceof` checks inside the other's compiled code, since Node treats
  separately-installed copies of the same package version as distinct
  classes. Workspace hoisting gives every package the same physical
  module instance.
- `authorizeAndSendSmartAccountCall` currently supports one context rule
  per call. A transaction needing two different rules authorized in the
  same call (not yet a real scenario anywhere in this workspace) would
  need a real extension, not silently produce a wrong result: the module
  throws if it finds more than one address-credential entry for the
  vault.
- The rest of `sdk/`'s specified surface (`createVault`, agent key
  management, webhooks, the management-plane API) remains unbuilt. This
  ADR closes the signing capability specifically, not the SDK package as
  a whole.
- `policy-swap`'s config now caches the real Soroswap pair address at
  install time. A vault that reinstalls `policy-swap` after the
  underlying pair somehow changes (Soroswap deploying a new pair for the
  same token combination, not something this workspace has observed)
  would need to reinstall to pick up the new address; there is no live
  re-resolution path, deliberately, since the reentrancy constraint rules
  one out.
