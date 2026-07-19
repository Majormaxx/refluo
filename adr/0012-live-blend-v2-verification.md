# ADR 0012: Blend V2 integration verified against a real pool, not calldata shape alone

Status: accepted. Date: 2026-07.

## Decision

`policy-venue`'s Blend `submit()` decoder is now verified against a real,
live Blend V2 testnet pool (`blend-capital/blend-utils`'
`testnet.contracts.json`, `poolFactoryV2`'s `TestnetV2` instance,
`CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF`), confirmed
live before use: `get_reserve_list` returns real XLM/wETH/wBTC/USDC
reserves, `get_config` returns a real Active pool. Real Blend V2 source
(`blend-contracts-v2`, `pool/src/pool/actions.rs`) confirms
`RequestType::Supply = 0`, matching this workspace's existing
`BLEND_SUPPLY` constant, not a fresh guess.

`contracts/policy-venue/scripts/testnet_smoke_test.sh` drives two real
halves: `policy-venue`'s own `enforce()` correctly allows a real
Supply(XLM) request shaped exactly like the real pool's `Request` struct,
correctly rejects a real Borrow request and a real over-cap Supply
request, all against the real pool's address as the configured venue. A
second, separate call submits directly to the real pool with real XLM,
and `get_positions()` read back afterward shows a real new supply
position, `{"supply":{"0":"6348111"}}` where it was empty before. 4/4
assertions passed on a live run.

## Why

Every previous verification of `enforce_blend_submit` used property tests
and unit tests, real logic, but against calldata this workspace itself
constructed based on documentation and inference, not the real pool.
Deploying against a real Blend V2 instance is the same discipline
`adr/0005` already established for oracle feeds: reading the field names
and structure a real contract actually expects, not the field names a
secondary source or a plausible guess suggested.

One genuine, reusable finding along the way: encoding a Rust struct
(Blend's `Request`, three named fields) as a raw `Val` argument through
`stellar-cli`'s dynamic `Vec<Val>` interface requires the full `ScVal`
map form, an array of `{key, val}` pairs, `{"map":[{"key":{"symbol":"address"},"val":{"address":"..."}}, ...]}`,
not a plain JSON object. Found by trial against the real deployed
contract after a plain-object attempt failed with a parse error, not
assumed from CLI documentation. Worth remembering for any future script
that builds `Context`/`Vec<Val>` calldata by hand for a policy contract's
`enforce()`, this repo's own `timelock` smoke test hits the same
encoding, just for a flat `Vec<Val>`, not a nested struct.

## Consequences

- `contracts/policy-venue/scripts/testnet_smoke_test.sh` is the first
  live smoke test for any of the three policy contracts; `policy-recall`
  and `policy-session` remain unit/property-tested only. `policy-venue`
  was the one Phase 3's "Blend V2 integration" gap specifically named,
  the one whose decode logic reads calldata for a real DeFi venue.
- This still tests `enforce()` and the real pool independently, not
  through a deployed `vault`'s `CustomAccountInterface`, for the same
  reason `adr/0008`'s drill stops short of full vault-mediated
  submission: `stellar-cli` can't construct the smart account's nested
  authorization entries yet. `enforce()`'s own auth
  (`smart_account.require_auth()`) is satisfied the same way a vault's
  `__check_auth` would satisfy it once the SDK's signing module exists,
  a plain account authorizing itself, so what's proven here is the real
  decode and gating logic against real calldata, not the vault
  authorization chain around it.
