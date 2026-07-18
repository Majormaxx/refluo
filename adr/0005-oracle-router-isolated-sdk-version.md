# ADR 0005: OracleRouter depends directly on `sep-40-oracle`, isolated on its own soroban-sdk version

Status: accepted. Date: 2026-07.

## Decision

`contracts/oracle-router` does not use `{ workspace = true }` for `soroban-sdk`
and does not depend on `refluo-common`. It pins its own `soroban-sdk ~25.3`
(matching `sep-40-oracle`'s requirement) and depends on `sep-40-oracle =
"1.4.0"` (published by script3) directly for `Asset`, `PriceData`, and the
`PriceFeedClient` used to call both Reflector and RedStone.

This mirrors the fix in `adr/0004`: rather than force one `soroban-sdk`
version across every crate in the workspace, each crate takes the version
its real dependencies need. `stellar-accounts` (vault, the three policies)
needs 26.1.0. `sep-40-oracle` needs ~25.3. `oracle-router` never calls into
`stellar-accounts` or the policy contracts directly, so nothing requires
these two islands to share a compilation unit — cross-contract calls
between them happen at the XDR level regardless of which `soroban-sdk`
major built either side, the same principle that already lets `BlendRequest`
work as a local mirror type instead of a Blend crate dependency (see
`contracts/common/src/lib.rs`).

Consequence: `oracle-router` defines its own local `OracleStatus` and
`PriceQuote` types rather than importing `refluo-common`'s, since that
crate is compiled against 26.1.0. The two are kept structurally identical
by hand; if `refluo-common`'s versions ever drift, nothing catches it
except manual review — flagged here so it isn't a silent trap later.

## Why

Verifying `sep-40-oracle` against its real source (crates.io, GitHub
`script3/sep-40-oracle`) turned up two things worth building around instead
of ignoring:

1. Its `Asset`/`PriceData` types are byte-for-byte identical in field
   layout to Reflector's own local types (confirmed against
   `reflector-network/reflector-contract`, `oracle/src/types.rs`) and to
   RedStone's SEP-40 wrapper. One client, both feeds — a real
   simplification over hand-rolling two separate integrations.
2. It hard-requires `soroban-sdk ~25.3`, which nothing else in the
   workspace uses. Every other crate resolved to 26.1.0 to satisfy
   `stellar-accounts`. Trying to reconcile these into one version wastes
   effort chasing a constraint that doesn't need to be satisfied in the
   first place, since `oracle-router` is architecturally independent of
   the vault/policy contracts.

## Consequences

- `oracle-router`'s `Cargo.toml` looks different from every other contract
  crate in the workspace on purpose. Don't "fix" it to match the others.
- If a future contract needs to cross-call `oracle-router` and also needs
  `stellar-accounts`, it talks to `oracle-router` through its generated
  client and a locally-defined mirror type (matching this pattern), not by
  importing `oracle-router`'s crate directly.
- Re-evaluate this split if `sep-40-oracle` or `stellar-accounts` ever
  converge on the same `soroban-sdk` major — at that point the isolation
  becomes unnecessary complexity rather than a real constraint.

## Addendum: per-feed asset keys, found only by deploying to testnet

`AssetOracleConfig` originally took one `Asset` value and passed it to both
feeds. Deploying to real testnet and configuring XLM against live Reflector
and RedStone contracts (not mocks) surfaced that this is wrong: Reflector's
testnet oracle keys XLM as `Asset::Other(Symbol("XLM"))`, while RedStone's
testnet SEP-40 wrapper keys the same asset as `Asset::Stellar(<the native
SAC contract address>)`. Two independent, correctly-implemented SEP-40
providers, two different addressing choices for the same real-world asset.
No amount of unit testing against same-shaped mocks would have caught
this, since a mock built from the same assumption doesn't get to falsify
that assumption.

Fixed by splitting the config into `primary_asset` and `secondary_asset`,
independent of the router's own logical asset key (used for config lookup,
storage, and events). Verified live end to end after the fix:
`contracts/oracle-router/scripts/testnet_smoke_test.sh` deploys fresh,
configures XLM with Reflector's `Other("XLM")` against RedStone's
`Stellar(<SAC>)`, and confirms a `Healthy` quote with both real feeds
agreeing to within ~0.1% — run twice, both times a clean pass on a fresh
deployment.

Lesson for the rest of the workspace: "deploy to testnet before calling a
contract done" is not a formality here. It found a real bug the unit test
suite structurally could not.
