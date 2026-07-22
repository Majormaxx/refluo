// Real session issuance: an HMAC-SHA256-signed token, not a session
// store or an external auth library — the dashboard has no user accounts
// to persist beyond "this address proved it controls this on-chain key
// and is currently an admin or guardian" (PRD 8.2's own auth model).
// Vanilla by design: a JWT library would add a dependency for a shape
// this is simple enough to hand-roll correctly and keep auditable in one
// file.
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_SECONDS = 3600;

export interface SessionPayload {
  address: string;
  role: "admin" | "guardian";
  issuedAtSeconds: number;
}

function sign(payloadJson: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadJson).digest("base64url");
}

export function issueSessionToken(payload: SessionPayload, secret: string): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = sign(payloadJson, secret);
  return `${payloadB64}.${signature}`;
}

/** Verifies a session token's signature and freshness. Returns the
 * payload only if both check out; a tampered or expired token yields
 * null, never a partially-trusted result. */
export function verifySessionToken(
  token: string,
  secret: string,
  nowSeconds: number,
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadB64, signature] = parts;
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expectedSignature = sign(payloadJson, secret);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadJson) as SessionPayload;
  } catch {
    return null;
  }
  if (nowSeconds - payload.issuedAtSeconds > SESSION_TTL_SECONDS) {
    return null;
  }
  return payload;
}
