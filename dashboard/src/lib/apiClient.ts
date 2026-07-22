"use client";
// Shared client-side fetch helper: every panel calls this instead of a
// raw fetch + ad hoc .catch(), so a failure always comes back as one
// typed ApiClientError with a real retryable flag parsed from the
// server's own error envelope (lib/apiError.ts), not a generic Error
// each component would otherwise have to re-parse itself.

export class ApiClientError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.retryable = retryable;
  }
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    // A thrown fetch (offline, DNS failure, CORS) is itself a real
    // network problem, always worth a retry affordance.
    throw new ApiClientError("Network request failed. Check your connection and retry.", 0, true);
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // A non-JSON body (an upstream proxy error page, for example) still
    // needs to surface as a real, typed failure.
  }

  if (!res.ok) {
    const record = (body ?? {}) as { error?: string; retryable?: boolean };
    throw new ApiClientError(
      record.error ?? `Request failed with status ${res.status}`,
      res.status,
      record.retryable ?? res.status >= 500,
    );
  }

  return body as T;
}
