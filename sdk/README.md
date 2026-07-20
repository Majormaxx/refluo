# @refluo/sdk

TypeScript SDK for agent operators, `@stellar/stellar-sdk` v14, Node 22.

The signing module (`src/smartAccountAuth.ts`) is real and working: it
constructs and submits a genuine multi-party-authorized transaction
through a `stellar-accounts` `SmartAccount`/`CustomAccountInterface`
vault, the capability `adr/0008` found missing from plain `stellar-cli`.
Live-verified against real deployed vaults: a real 2-of-3 admin call, a
real 1-of-3 rejection, a real 3-of-3 call, the full "Refluo disappears"
self-rescue drill (install and remove a real policy via real 2-of-3
calls), and `keeper/src/swap.ts` submitting a real swap through a real
vault's own `r_swap` context rule. See `adr/0016`.

The rest of the method surface drafted internally (not in this repo,
`createVault`, `configureRiskProfile`, `registerAgentKey`, `rotateAgentKey`,
`revokeAgentKey`, `fundVault`, `getVaultStatus`, `getBalance`,
`listTransactions`, `requestGuardianPause`, `requestRecall`,
`on(event, handler)`) is not built. This package currently exports one
real capability, not the full management-plane API.

Auth split for the eventual full surface: a scoped API key
(`refluo_live_...`) authorizes management-plane calls only, never spend.
Agent hot keys sign on-chain transactions directly and are bounded purely
by the on-chain policies.

## Usage

```typescript
import { authorizeAndSendSmartAccountCall } from "@refluo/sdk/smartAccountAuth";

const result = await authorizeAndSendSmartAccountCall({
  server,               // rpc.Server
  networkPassphrase,
  vaultAddress,          // the vault contract's own address
  contextRuleId,         // which context rule to authorize under (0 = R_ADMIN)
  unsignedTx,            // built with TransactionBuilder, one invokeHostFunction op
  coSigners,             // real Keypairs, must meet the rule's own threshold
  sourceKeypair,         // fee-paying source, may or may not be a co-signer
});
```

## Setup

```
npm install         # run from the repo root, this package is an npm workspace member
npm run test --workspace=sdk    # pure unit tests, no network needed
npm run build --workspace=sdk
npx tsx sdk/scripts/testnet_smoke_test.mjs   # real 2-of-3 / 1-of-3 / 3-of-3 against a fresh testnet vault
```

`sdk/`, `keeper/`, and `drills/` share one root `node_modules` via npm
workspaces (root `package.json`), not three separate installs: a real
`instanceof Transaction` mismatch across separately-installed copies of
`@stellar/stellar-sdk` forced this (`adr/0016`).
