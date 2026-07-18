# ADR 0004: Corrections from verifying stellar-accounts against real source

Status: accepted. Date: 2026-07.

## Decision

Implementing the vault and policy contracts required pulling
`stellar-accounts` v0.7.2's actual source (crates.io, not docs) before
writing any policy or vault code. Five assumptions from the
roadmap/implementation-spec turned out wrong. Recording them here so the
correction doesn't get silently re-lost:

1. **`soroban-sdk` pin is 26.1.0, not 27.0.0.** `stellar-accounts` v0.7.2
   hard-requires `soroban-sdk = "26.1.0"` with the
   `experimental_spec_shaking_v2` feature. Building against 27.0.0 (the
   original scaffold's pin, chosen to match Protocol 27/ADDRESS_V2) produces
   two incompatible `soroban-sdk` versions in the dependency graph and fails
   to compile. Workspace `Cargo.toml` now pins 26.1.0. Re-check this the
   moment OZ cuts a stellar-accounts release against soroban-sdk 27.
2. **`Policy` trait has 3 methods, not 4.** Both source documents assumed an
   `install`/`can_enforce`/`enforce`/`uninstall` lifecycle. The real trait
   (`stellar-accounts::policies::Policy`) has exactly `install`, `enforce`,
   `uninstall` — no `can_enforce`. `enforce` does both validation and
   enforcement in one call, matching OZ's own `spending_limit` reference
   implementation.
3. **`Context::Contract(ContractContext { contract, fn_name, args })`, not
   `Context::CallContract { .. }`.** The implementation spec's pseudocode
   used a plausible-sounding variant name that doesn't exist in
   `soroban_sdk::auth::Context`. All three policy contracts match on the
   real variant.
4. **`stellar-accounts` ships zero deployable `#[contract]` structs.** It's
   a pure library: the `Policy` trait, the `SmartAccount` trait, and
   `do_check_auth`. There is no prebuilt smart-account contract to deploy —
   `contracts/vault` had to implement `SmartAccount` and
   `CustomAccountInterface` directly. A second, sharper gotcha inside that:
   `#[contractimpl]` only exports methods **textually present** in the impl
   block. An empty `impl SmartAccount for Vault {}` (relying on the trait's
   documented defaults) compiles cleanly and then fails at runtime with
   "calling unknown contract function" — the default exists for Rust's
   benefit, not the WASM ABI's. Every `SmartAccount` method Refluo needs is
   now re-declared in `contracts/vault/src/lib.rs`, body-for-body identical
   to the trait default, matching the pattern in `stellar-accounts`'
   own README. Two methods (`get_signer_id`, `get_policy_id`) are not
   re-declared: their defaults call private `storage::*` functions not
   exposed outside the crate, so Refluo cannot reproduce them and they are
   simply absent from the vault's callable interface. Neither is required
   for anything built so far.
5. **Blend's `RequestType` has no `Claim` variant.** The implementation
   spec's enforce-logic pseudocode included a `CLAIM => allowed` arm
   alongside the numbered request types. The verified enum
   (`blend-contracts-v2` tag `v2.0.0`) is `Supply=0, Withdraw=1,
   SupplyCollateral=2, WithdrawCollateral=3, Borrow=4, Repay=5,
   FillUserLiquidationAuction=6, FillBadDebtAuction=7,
   FillInterestAuction=8, DeleteLiquidationAuction=9` — no eleventh
   variant. `policy-venue` and `policy-recall` only ever match 0-3;
   reward claiming, if Blend exposes it, is a separate top-level pool
   function outside `submit()` and is out of scope until verified.

## Why

Corrections 1-4 would have produced code that either didn't compile against
the real dependency or compiled but silently failed to expose the functions
a smart account needs at runtime — exactly the failure mode "hand-rolling
`__check_auth` is how solo devs die" warns against, except one layer up: it's
not enough to use OZ's framework, the integration details have to be
verified against source too. Correction 5 is a real security-relevant
narrowing: the roadmap's original mapping would have allowed reward claiming
through a request type that doesn't actually exist, wasting a match arm on
nothing rather than mis-permitting something dangerous — the direction of
the error happens to be harmless, but the underlying lesson (verify enums
against tagged source, not documentation prose) is not.

## Consequences

- The internal dependency risk register is updated to mark the
  `soroban-sdk` version and `Policy` trait shape as fully verified rather
  than assumed.
- Any future contract implementing an OZ trait must pull the real source
  first (`cargo info <crate>` then read `~/.cargo/registry/src/...`) before
  writing pseudocode-derived logic. This is now standing practice, not a
  one-time fix.
- The vault's `get_signer_id`/`get_policy_id` gap is a known, documented
  absence, not an oversight — if the SDK/dashboard ever needs those lookups,
  the fix is a feature request to OZ (export the storage functions) or a
  parallel registry Refluo maintains itself, not a workaround guess.
