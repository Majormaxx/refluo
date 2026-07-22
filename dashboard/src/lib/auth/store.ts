// In-memory challenge store: challenges are short-lived (5min TTL,
// challenge.ts's own CHALLENGE_TTL_SECONDS) and single-server by design
// for this reference dashboard (one operator's own deployment, not a
// horizontally-scaled multi-instance service), so a plain Map is the
// real, correct choice here, not a placeholder for a database that isn't
// otherwise part of this project's stack. A restart drops pending
// challenges, which only means an in-flight sign-in has to retry, never
// a security or data-loss concern.
import "server-only";
import type { Challenge } from "./challenge";
import { isChallengeExpired } from "./challenge";

const challenges = new Map<string, Challenge>();

export function putChallenge(challenge: Challenge): void {
  challenges.set(challenge.nonce, challenge);
}

export function takeChallenge(nonce: string, nowSeconds: number): Challenge | null {
  const challenge = challenges.get(nonce);
  if (!challenge) {
    return null;
  }
  // Single-use: consumed whether or not verification ultimately
  // succeeds, so a captured signature can never be replayed even against
  // its own original challenge.
  challenges.delete(nonce);
  if (isChallengeExpired(challenge, nowSeconds)) {
    return null;
  }
  return challenge;
}

/** Called opportunistically to keep the map from growing unbounded
 * across a long-running server process. */
export function pruneExpiredChallenges(nowSeconds: number): void {
  for (const [nonce, challenge] of challenges) {
    if (isChallengeExpired(challenge, nowSeconds)) {
      challenges.delete(nonce);
    }
  }
}
