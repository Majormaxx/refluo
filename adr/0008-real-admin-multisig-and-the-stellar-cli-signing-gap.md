# ADR 0008: Real 2-of-3 admin multisig, vault construction, and what stellar-cli can't sign

Status: accepted. Date: 2026-07.

## Decision

`R_ADMIN` is now a real M-of-N multisig, not a single delegated key. Three
pieces close this out:

1. **`contracts/policy-admin-threshold`**, a new thin wrapper around OZ
   `stellar-accounts`' own `simple_threshold` module (equal-weight M-of-N,
   the plain multisig case the original spec's "2-of-3 threshold" language
   describes, distinct from the crate's separately-available weighted
   variant with per-signer weights). Every method delegates to the
   library's `install`/`enforce`/`uninstall`, no logic of Refluo's own.
2. **`vault` gained a real `__constructor`.** Every other admin-management
   method requires `e.current_contract_address().require_auth()`, which
   resolves through the vault's own `__check_auth`, which requires
   selecting an *existing* context rule to validate against
   (`get_validated_context_by_id` panics on an unknown id). A brand-new
   vault has zero rules, so nothing else could ever create the first one.
   Construction runs once, authorized by the deploying transaction rather
   than the not-yet-existing account's own policy, the standard pattern
   every real Soroban smart-wallet factory uses.
3. **Live testnet deployment, first ever for this contract.** `vault` and
   `policy-admin-threshold` had never been deployed anywhere before this;
   every other contract in this workspace got that treatment when it was
   built, this one predates the standard hardening after the OracleRouter
   asset-key bug. Deployed for real, bootstrap verified: `R_ADMIN` holds
   all three real testnet admin addresses and `policy-admin-threshold`
   genuinely stores `threshold=2`, read back from the deployed contract,
   not asserted.

## Why

`adr/0002` and every enforcement contract this session already established
the pattern: OZ ships the primitive, Refluo wraps it thin. `simple_threshold`
is that primitive for plain M-of-N, so building anything custom would have
repeated the same mistake `adr/0001` exists to prevent.

The constructor gap is a real one a plain unit test suite could never
surface: every existing test used `mock_all_auths()`, which bypasses
`__check_auth` entirely, so nothing ever needed to ask how a fresh vault's
first rule gets created against genuine authorization. Only attempting a
live deployment (`e.register(Vault, ())` with no constructor, then no way
to call `add_context_rule` for real) forced the question, and needing
CAP-71-relevant address handling with it. On that: `ADDRESS_V2` is
satisfied by construction. `soroban_sdk::Address` is fully opaque to
whether the underlying `ScAddress` is a classic account or a V2 muxed
account for every on-chain operation (`require_auth`, storage keys,
equality), confirmed by reading `address.rs` directly. The only place
`MuxedAccount` gets special-cased at all is a native-only, WASM-excluded
`Debug` formatter that can't render one as a display string, which never
touches on-chain behavior. Nothing in this workspace hardcodes a
V1-specific assumption, so there was nothing to add.

## The stellar-cli signing gap

Attempting the live "Refluo disappears" drill surfaced a genuine, general
finding, not a Refluo-specific bug: `Signer::Delegated(addr)`'s real
authentication path
(`stellar-accounts`' `authenticate()`) doesn't check a custom signature
blob at all. It calls `addr.require_auth_for_args((auth_digest,))`,
delegating to the standard Soroban host auth check for that signer's own
classic account. Multisig here therefore needs multiple nested Soroban
authorization entries, one genuine host-level auth check per co-signing
admin, not a single value `stellar-cli` can auto-construct.

`stellar tx sign --sign-with-key` only auto-signs the simple case: one
classic account authorizing its own top-level call. It has no concept of
"construct an `AuthPayload` naming which 2 of 3 delegated signers are
co-authorizing this specific call", confirmed by simulating a real
`add_signer` call against the deployed vault and watching the custom
account's auth entry stay `signature: void` through every signing attempt.
That construction requires a client that understands this specific custom
account's authorization scheme. That client is the SDK (`sdk/`, not yet
built), not a gap in the contracts.

## Consequences

- The live signing half of the self-rescue drill is deferred to when the
  SDK's signing module exists, since it needs to build exactly this
  capability regardless, constructing `AuthPayload`s and gathering
  co-signatures is core SDK functionality, not optional. Building a
  one-off script now would duplicate work the SDK has to do properly
  later.
- The self-rescue guarantee's actual security property is unaffected:
  once the SDK does this signing, it runs as the operator's own local
  client, not infrastructure Refluo hosts, so "recoverable without
  Refluo's company or servers existing" still holds. Only the literal
  "using stellar-cli alone, no SDK" phrasing needs updating to "using the
  SDK's signing module, run locally by the operator, no Refluo backend
  involved" once that module exists.
- Everything provable without live multi-party signing is provable now
  and has been: the threshold contract's own enforcement logic (2-of-3
  correctly required, 1-of-3 correctly rejected, 6 tests), the
  constructor's bootstrap wiring (real signers, real threshold, read back
  from a live deployment), and `ADDRESS_V2` compatibility by construction.
