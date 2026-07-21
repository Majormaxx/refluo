# dashboard

Operator dashboard for one Refluo vault (PRD 8.2): vault overview, real
SLA telemetry, guardian pause/resume, the timelock queue, and alert
routing config. A signing UI, not a privileged backend — every state-
changing call is built, simulated, and signed in the browser through the
connected wallet; the server never holds a private key.

Next.js 16 (App Router), Tailwind CSS v4, shadcn/ui (`base-nova` style,
built on `@base-ui/react`). See `adr/0021` for the full architecture, the
real findings from building it, and the one disclosed gap: no real
browser + Freighter extension exists in this project's own dev sandbox,
so the click-through signing flow is unverified end to end (everything
it depends on — SEP-53 crypto, on-chain role resolution, wallet-error
classification, the compiled UI — is independently real and verified,
see the ADR for exactly what and how).

## Setup

```bash
npm install
cp .env.example .env.local   # fill in VAULT_ADDRESS, RISK_ENGINE_ID,
                              # RISK_ENGINE_ACCOUNT, HEALTH_MONITOR_ID,
                              # TIMELOCK_ID, SESSION_SECRET (openssl rand
                              # -hex 32), and the NEXT_PUBLIC_ mirrors
npm test                      # 47 real unit tests, no network needed
npm run dev                   # http://localhost:3000
npm run build                 # production build + typecheck
npm run lint
```

Requires a real Freighter wallet extension in the browser to sign in or
take any action; viewing the timelock queue needs no auth (watcher
transparency, PRD 8.2's own wording).

## Auth model

A real SEP-53 ("Stellar Signed Message") challenge/response — the exact
scheme Freighter's own `signMessage()` signs, not a custom scheme. A
verified address is mapped to a real on-chain role (admin: a `Delegated`
signer on the vault's `R_ADMIN` context rule; guardian: HealthMonitor's
real `guardian` `AccessControl` role, `adr/0020`), re-checked on every
sign-in, no separate identity system, no cache. Sessions are a hand-
rolled HMAC-SHA256 token (`src/lib/auth/session.ts`), not a JWT library.

## Error handling

Every API route classifies real failures into `{error, retryable}`
(`src/lib/apiError.ts`): known transient RPC-message patterns this
workspace has actually hit (timeouts, `Account not found`, the event-
retention boundary error) come back retryable, everything else doesn't.
The client mirrors it (`src/lib/apiClient.ts`, `src/hooks/useApiResource.ts`)
so every panel gets the same real "Retry" affordance
(`src/components/PanelError.tsx`). Signing-action failures are classified
against the real error classes `@stellar/stellar-sdk/contract`'s own
`AssembledTransaction.sign()` throws for a real Freighter rejection
(`src/lib/actions/actionError.ts`) — a cancelled signature reads
differently from a real wallet error, which reads differently from a
real on-chain rejection. Every panel is wrapped in a real Next 16.2
`unstable_catchError` boundary (`src/components/PanelErrorBoundary.tsx`):
one panel crashing doesn't take down the rest of the dashboard. Route-
level crashes get `src/app/error.tsx` / `global-error.tsx`.

## Project structure

```
src/app/                 pages + API routes (server-side reads/auth)
src/components/          panels + shared UI (shadcn primitives under ui/)
src/hooks/                useAuth, useFreighter, useApiResource
src/lib/contracts/       real on-chain reads per panel
src/lib/actions/         real browser-signed writes per panel
src/lib/auth/            SEP-53 challenge/session/authorization
packages/                generated `stellar contract bindings typescript`
                         clients, regenerate the same way keeper/ does
```

## Regenerating a contract client

Same convention as `keeper/`:

```bash
stellar contract bindings typescript \
  --wasm ../target/wasm32v1-none/release/refluo_<contract>.wasm \
  --output-dir packages/<contract>-client --network testnet --overwrite
cd packages/<contract>-client && npm install && npm run build
```
