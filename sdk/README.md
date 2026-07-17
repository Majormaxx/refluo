# @refluo/sdk

TypeScript SDK for agent operators, `stellar-sdk` v16, Node 22. Method
surface already drafted internally, not in this repo: `createVault`,
`configureRiskProfile`, `registerAgentKey`, `rotateAgentKey`,
`revokeAgentKey`, `fundVault`, `getVaultStatus`, `getBalance`,
`listTransactions`, `requestGuardianPause`, `requestRecall`,
`on(event, handler)`.

Auth split: a scoped API key (`refluo_live_...`) authorizes management-plane
calls only, never spend. Agent hot keys sign on-chain transactions directly
and are bounded purely by the on-chain policies.

Not started. Placeholder so the workspace layout matches the architecture
doc.
