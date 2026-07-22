// SEP-53 ("Stellar Signed Message") challenge/verify, the real scheme
// Freighter's own signMessage() uses under the hood (confirmed from
// Freighter's real source: extension/src/background/messageListener/
// handlers/signBlob.ts calls encodeSep53Message(message), then
// sourceKeys.sign(that hash) — not guessed, the same "read the real
// signer's source before writing a verifier" discipline this workspace
// used for Reflector's notification signatures). A verifier has to
// reproduce the exact preimage or every real signature fails to verify:
//
//   hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message)]))
//
// This is the dashboard's whole auth model (PRD 8.2): a wallet-signature
// challenge mapped to the admin/guardian addresses already on-chain for
// the vault, no separate password/identity system. Pure crypto here, no
// network; session.ts issues the resulting session, authorization.ts maps
// a verified address to real on-chain admin/guardian status.
import { Keypair, hash } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";

export const SEP53_PREFIX = "Stellar Signed Message:\n";

const CHALLENGE_TTL_SECONDS = 300;

export interface Challenge {
  nonce: string;
  address: string;
  issuedAtSeconds: number;
}

/** The real message text the wallet is asked to sign — human-readable,
 * so a user reviewing the Freighter signing prompt can see exactly what
 * they're authenticating, not a bare hex blob. */
export function challengeMessage(challenge: Challenge): string {
  return (
    `Refluo dashboard sign-in\n` +
    `address: ${challenge.address}\n` +
    `nonce: ${challenge.nonce}\n` +
    `issued: ${challenge.issuedAtSeconds}`
  );
}

export function createChallenge(address: string, nowSeconds: number): Challenge {
  return {
    nonce: randomBytes(16).toString("hex"),
    address,
    issuedAtSeconds: nowSeconds,
  };
}

export function isChallengeExpired(challenge: Challenge, nowSeconds: number): boolean {
  return nowSeconds - challenge.issuedAtSeconds > CHALLENGE_TTL_SECONDS;
}

/** The exact real SEP-53 preimage a Freighter-signed message signs over. */
export function sep53Hash(message: string): Buffer {
  const prefixed = Buffer.concat([
    Buffer.from(SEP53_PREFIX, "utf8"),
    Buffer.from(message, "utf8"),
  ]);
  return hash(prefixed);
}

/** Verifies a real Ed25519 signature over a real SEP-53-encoded message,
 * matching the exact bytes Freighter's own signMessage() signs. Fails
 * closed (returns false) on any malformed input rather than throwing, so
 * callers can treat this as a plain boolean gate. */
export function verifySep53Signature(
  message: string,
  signature: Buffer,
  claimedAddress: string,
): boolean {
  try {
    return Keypair.fromPublicKey(claimedAddress).verify(sep53Hash(message), signature);
  } catch {
    return false;
  }
}

/** End-to-end challenge verification: the signature must be real, the
 * signer must match the claimed address, and the challenge must not have
 * expired — replay protection plus authenticity, not authenticity alone. */
export function verifyChallengeResponse(
  challenge: Challenge,
  signature: Buffer,
  nowSeconds: number,
): boolean {
  if (isChallengeExpired(challenge, nowSeconds)) {
    return false;
  }
  return verifySep53Signature(challengeMessage(challenge), signature, challenge.address);
}
