// Quorum tracking for Reflector Subscriptions push notifications. Pure
// state machine, no network: a single Reflector node's signed
// notification is not itself trust (reflector-node's own docs describe
// each node sending independently for the same trigger event, the same
// "hasMajority" consensus convention its own internal replication logic
// uses elsewhere), so a webhook receiver has to accumulate matching,
// independently-signed notifications from a real quorum of distinct
// trusted verifier keys before treating a pushed price as confirmed, not
// act on the first signature that verifies. Kept separate from
// reflectorWebhookServer.ts so the quorum logic is testable without an
// HTTP server or real network traffic.
import {
  computeUpdateHash,
  verifyNotificationSignature,
  type ReflectorNotification,
  type ReflectorUpdate,
} from "./reflectorSubscription.js";

export type QuorumResult =
  | { status: "rejected-bad-signature" }
  | { status: "rejected-untrusted-verifier"; verifier: string }
  | { status: "duplicate"; confirmingVerifiers: string[] }
  | { status: "recorded"; confirmingVerifiers: string[]; needed: number }
  | { status: "quorum-reached"; event: ReflectorUpdate; confirmingVerifiers: string[] }
  | { status: "already-resolved"; confirmingVerifiers: string[] };

interface PendingGroup {
  event: ReflectorUpdate;
  firstSeenSeconds: number;
  confirmingVerifiers: Set<string>;
  resolved: boolean;
}

export class QuorumTracker {
  private readonly trustedVerifiers: Set<string>;
  private readonly quorumSize: number;
  private readonly windowSeconds: number;
  private readonly groups = new Map<string, PendingGroup>();

  constructor(trustedVerifiers: string[], quorumSize: number, windowSeconds: number) {
    if (quorumSize < 1) {
      throw new Error("quorumSize must be at least 1");
    }
    if (quorumSize > trustedVerifiers.length) {
      throw new Error(
        `quorumSize (${quorumSize}) cannot exceed the number of trusted verifiers (${trustedVerifiers.length})`,
      );
    }
    this.trustedVerifiers = new Set(trustedVerifiers);
    this.quorumSize = quorumSize;
    this.windowSeconds = windowSeconds;
  }

  /** Records one notification and returns the resulting quorum state.
   * Idempotent per (verifier, event) pair: a duplicate POST from the same
   * verifier for the same event never double-counts toward quorum. */
  recordNotification(notification: ReflectorNotification, nowSeconds: number): QuorumResult {
    this.pruneExpired(nowSeconds);

    if (!verifyNotificationSignature(notification)) {
      return { status: "rejected-bad-signature" };
    }
    const verifier = notification.verifier;
    if (!this.trustedVerifiers.has(verifier)) {
      return { status: "rejected-untrusted-verifier", verifier };
    }

    const event = notification.update.event;
    const key = computeUpdateHash(event).toString("hex");
    let group = this.groups.get(key);
    if (!group) {
      group = {
        event,
        firstSeenSeconds: nowSeconds,
        confirmingVerifiers: new Set(),
        resolved: false,
      };
      this.groups.set(key, group);
    }

    if (group.resolved) {
      return {
        status: "already-resolved",
        confirmingVerifiers: [...group.confirmingVerifiers],
      };
    }

    if (group.confirmingVerifiers.has(verifier)) {
      return { status: "duplicate", confirmingVerifiers: [...group.confirmingVerifiers] };
    }
    group.confirmingVerifiers.add(verifier);

    if (group.confirmingVerifiers.size >= this.quorumSize) {
      group.resolved = true;
      return {
        status: "quorum-reached",
        event: group.event,
        confirmingVerifiers: [...group.confirmingVerifiers],
      };
    }
    return {
      status: "recorded",
      confirmingVerifiers: [...group.confirmingVerifiers],
      needed: this.quorumSize - group.confirmingVerifiers.size,
    };
  }

  /** Drops groups whose first notification fell outside the trust
   * window, so a stale, never-confirmed event can't quietly accumulate
   * confirmations forever or leak memory in a long-running process. */
  private pruneExpired(nowSeconds: number): void {
    for (const [key, group] of this.groups) {
      if (nowSeconds - group.firstSeenSeconds > this.windowSeconds) {
        this.groups.delete(key);
      }
    }
  }
}
