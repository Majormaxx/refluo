// Shared API-route error handling. Every route that touches real
// infrastructure (the RPC, the local reporter snapshot/alerts files)
// wraps its handler in withErrorHandling so a thrown error always comes
// back as a clean, typed JSON envelope {error, retryable} instead of
// Next's generic unhandled-exception response — this dashboard's own
// reads hit the same public testnet RPC the rest of this workspace has
// documented as intermittently flaky (timeouts, transient "Account not
// found", a fluctuating event-retention boundary, see
// lib/contracts/healthMonitor.ts's header comment), and an operator
// looking at a paused vault needs to tell "the network hiccuped, retry"
// apart from "something is actually broken." No "server-only" marker:
// unlike stellar.ts, nothing here touches a secret or an env var, and
// keeping it importable from a plain Node context is what lets
// classifyError/ApiError get real unit tests (apiError.test.ts) without
// needing Next's own server-component module resolution.
import { NextResponse } from "next/server";

export class ApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class UnauthenticatedError extends ApiError {
  constructor(message = "unauthenticated") {
    super(message, 401, false);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "insufficient permissions") {
    super(message, 403, false);
  }
}

// Real error text this workspace has actually seen thrown from the
// public testnet RPC or Node's own network stack during live testing
// (see keeper/, sdk/, and this dashboard's own header comments) —
// classified as retryable, not guessed patterns.
const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENETUNREACH/i,
  /ENOTFOUND/i,
  /fetch failed/i,
  /account not found/i,
  /rate limit/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /startLedger must be within/i,
];

function isTransient(message: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Classifies any thrown value into an ApiError. Unknown errors default
 * to 500/non-retryable rather than assuming they're safe to retry. */
export function classifyError(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (isTransient(message)) {
    return new ApiError(
      "Temporary network or RPC issue talking to the Stellar testnet. Please retry.",
      503,
      true,
    );
  }
  return new ApiError(message, 500, false);
}

function toErrorResponse(err: unknown): NextResponse {
  const apiError = classifyError(err);
  // Server-side log always keeps the real message/stack for an
  // operator, even though the client response is deliberately terser.
  console.error(
    `[api] ${apiError.status}${apiError.retryable ? " retryable" : ""}: ${apiError.message}`,
    err instanceof Error ? err.stack : err,
  );
  return NextResponse.json(
    { error: apiError.message, retryable: apiError.retryable },
    { status: apiError.status },
  );
}

/** Wraps a route handler so any throw — an auth failure, a real
 * on-chain rejection, or a transient RPC blip — becomes the same clean
 * JSON envelope, never Next's generic unhandled-exception page. */
export async function withErrorHandling(
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (err) {
    return toErrorResponse(err);
  }
}
