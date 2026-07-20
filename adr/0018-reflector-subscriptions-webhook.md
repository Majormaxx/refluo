# ADR 0018: Reflector Subscriptions webhook, quorum, and the RedStone cross-check

Status: accepted, with one disclosed live-verification gap. Date: 2026-07.

## Decision

Reflector's real Subscriptions mechanism (`reflector-network/reflector-subscription-contract`)
is entirely off-chain for delivery: a subscriber registers an encrypted
webhook URL on-chain, and Reflector's own real node cluster independently
POSTs signed JSON directly to that URL once a subscription's trigger
conditions are met. There is no on-chain callback into a subscriber's
contract anywhere in that contract's real source; the on-chain `trigger()`
call is an admin-only audit anchor of a merkle-style root hash, not a
delivery path. This workspace's receiver has to be a real HTTP server, not
a Soroban event handler.

`keeper/src/reflectorSubscription.ts` is the pure signature/cross-check
logic: `sortObjectKeys` + `JSON.stringify` + `sha256` + Ed25519 verify,
copied field-for-field from `reflector-node`'s own real source
(`subscriptions-processor.js`, `reflector-shared`'s
`serialization-helper.js`), not guessed, because a receiver has to
reproduce a signer's exact canonicalization byte for byte or every real
signature fails to verify. `crossCheckPrice` compares a confirmed price
against a real RedStone REST quote (`api.redstone.finance/prices`, a real
live endpoint, confirmed by direct query) using the same divergence-bps
convention `oracle-router`'s own on-chain check already uses (`adr/0005`).

`keeper/src/reflectorQuorum.ts` is the trust layer: one node's signature
is not itself confirmation (Reflector's own docs describe every node
sending independently for the same event, the same `hasMajority`
consensus convention its own internal replication logic uses elsewhere),
so `QuorumTracker` accumulates distinct, independently-verified trusted
verifier confirmations for the same event hash and only reports
`quorum-reached` once a configured threshold of distinct keys agree.
Reflector's own node membership is DAO-governed and changes over time; no
reliable static list of current node keys was found to hardcode, so the
trusted set is an operator-configured env var
(`REFLECTOR_TRUSTED_VERIFIERS`), not baked into the code.

`keeper/src/reflectorWebhookServer.ts` wires it together: a plain
`node:http` server (no framework needed for one POST route), body-size
capped before JSON parsing, malformed or unverifiable POSTs rejected
before they ever reach quorum tracking. Once quorum is reached, it fetches
a real RedStone quote and pauses `health-monitor` only if the two diverge
beyond a configured hard band. The pause call itself needs no
smart-account auth: `HealthMonitor.pause` takes a guardian's own
`require_auth()` directly, so the keeper's own key signs as itself,
provided it is already in the deployed `HealthMonitor`'s guardian set —
no dependency on `adr/0016`'s vault signing module for this specific call.

`keeper/src/reflectorSubscriptionManager.ts` wraps the real published
`@reflector/subscription-client` npm package (MIT,
`reflector-network/reflector-subscription-client`) for
create/get/deposit/cancel, with an explicit `contractId` override.

## The disclosed gap: no real testnet Subscriptions contract found

Exhaustively searched: GitHub code search across the entire
`reflector-network` org, the subscription contract's and node's own real
source, reflector.network's docs, general web search. The published
client's own default `contractId` is mainnet-only
(`CBNGTWIVRCD4FOJ24FGAKI6I5SDAXI7A4GWKSQS7E6UYSR4E4OHRI2JX`); nothing
discoverable points at a non-mainnet deployment. This means
`create_subscription`/`deposit`/`cancel` cannot be live-verified against
real testnet infrastructure in this pass, and a real Reflector node
cannot actually POST to this workspace's webhook server (no publicly
reachable HTTPS endpoint exists in this sandboxed environment either,
compounding the same gap). Both are genuine external-infrastructure
constraints, not something more code resolves — stated as BLOCKED for
that specific slice, not faked.

Everything downstream of "a Reflector-shaped signed POST arrives" is real
and live-verified instead (`keeper/scripts/reflector_webhook_smoke_test.mjs`):
a fresh `HealthMonitor` deployed live with this keeper's key as its real
registered guardian, the real HTTP server started and POSTed to over a
real loopback socket, two throwaway keypairs standing in for real
Reflector node keys (configured as this run's trusted verifiers, so the
cryptographic scheme under test is the real one, only the signing keys
are local), a real RedStone REST fetch, and a real
`HealthMonitor.pause()` transaction landing on testnet with `SUCCESS`,
confirmed by a real `status()` read before (`false`) and after (`true`).
A synthetic untrusted verifier's correctly-signed notification was also
confirmed rejected before ever reaching quorum. 6/6 passed live.

## Consequences

- Live-verifying subscription creation/deposit/cancel, and an actual
  Reflector-node-originated POST, both stay blocked on external
  infrastructure this workspace does not control. Re-run
  `reflector_webhook_smoke_test.mjs`'s premise (synthetic but
  correctly-shaped, real-crypto POSTs) is the practical ceiling for this
  environment; if a real testnet Subscriptions deployment or a publicly
  reachable webhook endpoint becomes available, this is the first thing
  to re-verify against it.
- The trusted-verifier set is an operator responsibility, not a
  contract-enforced list. A wrong or stale `REFLECTOR_TRUSTED_VERIFIERS`
  value means either false rejections (Reflector rotated node keys) or,
  in the worst case, an operator who trusted keys they should not have —
  this is a real operational surface, not a code bug, and belongs in the
  incident runbook.
- `@reflector/subscription-client`'s own published `.d.ts` declares
  `callTimeout`/`defaultFee`/`noRestore` as required and omits
  `contractId`/`networkPassphrase` entirely; the real JS constructor
  (confirmed from source) defaults all three and does accept both. Worked
  around with a type-only cast in `reflectorSubscriptionManager.ts`,
  documented inline so a future upgrade of the package can re-check
  whether the upstream types were fixed.
- `crossCheckPrice`'s hard-divergence band and `QuorumTracker`'s quorum
  size are both real keeper config, not resolved from an on-chain source,
  the same boundary `adr/0013` and `adr/0017` already drew for
  off-chain-owned parameters.
