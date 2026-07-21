# ADR 0021: Operator dashboard — auth model, Tailwind/shadcn UI, and error handling

Status: accepted, with one disclosed live-verification gap. Date: 2026-07.

## Decision

`dashboard/` is a Next.js 16 App Router app, one instance per vault (the
spec's own scoping, PRD 8.2): a signing UI, not a privileged backend.
Every state-changing call (`pause`, `resume_early`, `cancel`) is built,
simulated, and signed entirely in the browser through the real connected
wallet (Freighter); the server never holds or transmits a private key.

**Auth**: a real SEP-53 ("Stellar Signed Message") challenge/response,
the exact scheme Freighter's own `signMessage()` uses under the hood
(`hash("Stellar Signed Message:\n" + message)`, confirmed from
Freighter's real source, not guessed). A verified address is mapped to a
real on-chain role by simulating against the vault's own R_ADMIN context
rule (`Delegated` signer membership) and HealthMonitor's real `guardian`
role (`adr/0020`) — no separate identity system, re-checked on every
sign-in rather than cached, so a revoked admin or removed guardian loses
access the moment their on-chain rights are actually revoked. Sessions
are a hand-rolled HMAC-SHA256 token (`lib/auth/session.ts`), not a JWT
library: the shape is simple enough to keep in one auditable file.

**UI**: Tailwind CSS v4 (`@import "tailwindcss"` in `globals.css`, no
`tailwind.config.js` needed) plus shadcn/ui's current `base-nova` style,
built on `@base-ui/react` rather than Radix (shadcn's own current default
component library, confirmed via `shadcn init`'s own `-b/--base` flag
listing `base`/`radix`/`aria`). `next-themes` drives light/dark via a
`.dark` class, matching shadcn's own generated `globals.css` theme
tokens.

**Error handling**, the other half of this pass:

- Every API route wraps its handler in `lib/apiError.ts`'s
  `withErrorHandling`, which classifies any thrown error into
  `{error, retryable}` — real transient-RPC message patterns this
  workspace has actually seen (`ETIMEDOUT`, `Account not found`, the
  `startLedger must be within...` retention error) are marked
  `retryable: true`, everything else defaults to `500`/non-retryable
  rather than assumed safe to retry. `UnauthenticatedError`/
  `ForbiddenError` carry real 401/403 status through the same path.
- The browser side mirrors it: `lib/apiClient.ts`'s `fetchJson` parses
  that envelope into a typed `ApiClientError`, and `hooks/useApiResource.ts`
  is the one data-fetching hook every panel uses, exposing a real
  `reload()` a "Retry" button (`components/PanelError.tsx`) wires to.
- Signing-action failures get their own classifier
  (`lib/actions/actionError.ts`), built on a real finding: `@stellar/
  stellar-sdk/contract`'s own `AssembledTransaction.sign()` already turns
  Freighter's raw `{error: {code, message}}` result into typed error
  classes (`UserRejectedError` for code -4, `InternalWalletError` for -1,
  `ExternalServiceError` for -2, `InvalidClientRequestError` for -3 —
  read from `assembled_transaction.js`'s own `handleWalletError`, not
  guessed) — this module only needed to recognize those classes via
  `instanceof`, not reparse Freighter's error shape itself. Raw
  Freighter calls that don't go through `AssembledTransaction` (`signMessage`,
  `requestAccess`) get the same code-based classification via a small
  parallel `describeFreighterApiError`.
- Every panel is wrapped in `components/PanelErrorBoundary.tsx`, built on
  Next 16.2's own `unstable_catchError` (`next/error`) rather than a
  hand-rolled class component — new in this exact Next version, and the
  documented replacement for ad hoc error boundaries. A render crash in
  one panel shows a real "Reload panel" fallback; every other panel keeps
  working. Route-level crashes get `app/error.tsx` and
  `app/global-error.tsx` (the latter defining its own `<html>/<body>`,
  required since it replaces the root layout).
- Every signing action and sign-in/out surfaces its outcome via a real
  Sonner toast (`components/ui/sonner.tsx`) in addition to inline state,
  so the result is visible even after the user has scrolled away.

## Real findings from building it

**`RiskEngine.init()` needs a plain self-authorizing identity, not the
vault.** An early version pointed `RiskEngine`'s own `account` parameter
at the vault contract's address; `RiskEngine.init()` calls
`account.require_auth()` directly, which a `CustomAccountInterface` vault
cannot satisfy without the SDK's full multi-party signing flow
(`adr/0016`) just to read state. Fixed with a separate
`RISK_ENGINE_ACCOUNT` env var, matching `keeper/.env.example`'s existing
`ACCOUNT` convention — the same real distinction that workspace already
had to make.

**Timelock's real event topics are the full struct name in snake_case,
not the bare verb.** A real `propose()` + `cancel()` round trip against a
live deployed `timelock` decoded as `propose_event`/`cancel_event`, not
`propose`/`cancel` — the same lesson `adr/0017`'s USDC topics and
`adr/0019`/`adr/0020`'s HealthMonitor topics already taught this
workspace: read the real emitted event, never assume the shape from the
Rust struct name. `execute_event`'s shape is inferred from
`cancel_event`'s identical single-topic-field structure, not
independently live-verified — a real `execute()` needs the full real 24h
`PROPOSAL_DELAY` to elapse first, not reproducible in one session.

**The public testnet RPC's real `getEvents` retention fluctuates and can
be much shorter than `adr/0017`'s ~121,000-ledger figure.** Binary-
searching a real deployed `HealthMonitor`'s own `Paused` event across two
separate rounds found the safe/unsafe boundary between 10,000–20,000
ledgers in one round and had already moved to 10,000–15,000 minutes
later against a fresh deployment — provider/load-balancer dependent, not
a fixed window. A too-far-back query fails two different ways depending
on how far past the real boundary it lands: a hard `startLedger out of
range` error for a very large window, or a silent empty result for a
moderately-too-large one — confirmed both, live.
`HEALTH_MONITOR_PAUSE_LOOKBACK_LEDGERS`/`TIMELOCK_PROPOSALS_LOOKBACK_LEDGERS`
both default to 10,000, the one value that held safely across both
rounds; a real pause or proposal older than that lookback still exists
on-chain and is directly readable via `get_proposal(id)`/`status()`, it
just won't appear in the reconstructed lists this dashboard builds from
events.

**`node --test`'s glob argument needs shell-quoting under `sh`.** The
original `"test": "node --import tsx --test src/**/*.test.ts"` script
silently ran only the top-level `src/lib/*.test.ts` files: `npm run`
invokes scripts via `sh -c`, and `sh` (unlike interactive bash) does not
expand `**` recursively, so the glob quietly degraded to one directory
level and `challenge.test.ts`/`session.test.ts`/`actionError.test.ts`
never ran, with no error — a passing `npm test` was silently only
partial coverage. Fixed by single-quoting the glob in the script string
so the shell never touches it, letting Node's own `--test` glob
implementation (which does recurse correctly) expand it instead;
confirmed by running the exact quoted command directly and comparing the
reported test count (17 vs. the real 47) before and after.

## Live verification

`npm run build`, `npm run lint`, and `npm test` (47 tests, all real unit
tests: SEP-53 sign/verify round-trips against locally generated
keypairs, session token HMAC round-trips, `classifyError`'s pattern
matching against real error strings this workspace has actually seen,
`validateAlertsConfigPatch`'s URL validation, `describeActionError`/
`describeFreighterApiError` against real `AssembledTransaction.Errors`
instances) all pass clean. `next dev` was started for real and exercised
directly: the homepage renders real panel markup and a real compiled
Tailwind/shadcn stylesheet (55KB, confirmed `oklch`/theme tokens
present), `/api/timelock/proposals` returned a real pending proposal from
a live deployed `timelock` (no auth required, by design), and every
auth-gated route correctly returned the new `{error: "unauthenticated",
retryable: false}` envelope with a real `401` before any handler logic
ran.

## The disclosed gap

No real browser with the Freighter extension installed exists in this
sandboxed environment, so the actual click-through signing flow (connect
→ sign challenge → pause/resume/cancel → observe a real toast) is
unverified end to end. Every piece it depends on is independently real
and verified instead: the SEP-53 crypto (unit-tested against real
signatures), the on-chain role resolution (real simulate calls against
real deployed contracts, exercised via curl above), the
`AssembledTransaction`/Freighter error classification (real SDK
behavior, read from source and unit-tested against the real exported
error classes), and the compiled UI (rendered and served for real). The
first real click-through test against an actual wallet extension is the
next thing to run once a real browser environment is available.

## Consequences

- `NEXT_PUBLIC_*` env vars duplicate their server-only counterparts
  (`lib/publicConfig.ts` vs `lib/stellar.ts`) by necessity: contract ids
  are public addresses, safe to inline into the client bundle, but Next
  only inlines values explicitly prefixed `NEXT_PUBLIC_` at build time,
  so there is no way to derive one set from the other automatically.
  Keep both in sync by hand when rotating a contract deployment.
- `PanelErrorBoundary`'s `unstable_catchError` and `error.tsx`'s
  `unstable_retry` prop are both new in Next 16.2.0 and explicitly marked
  unstable upstream; a future Next upgrade may rename or stabilize them,
  worth re-checking against that version's own docs before upgrading
  rather than assuming the API is frozen.
- The alerts config's URL validation (`lib/alertsConfigValidation.ts`)
  only checks that a value parses as a real http(s) URL, not that the
  endpoint is reachable or actually a valid Slack/Discord/PagerDuty
  webhook — a syntactically valid but wrong URL still saves successfully,
  the same boundary any config validator without a live reachability
  probe has.
