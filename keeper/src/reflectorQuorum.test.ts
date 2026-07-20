import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { QuorumTracker } from "./reflectorQuorum.js";
import { computeUpdateHash, type ReflectorNotification, type ReflectorUpdate } from "./reflectorSubscription.js";

function sampleUpdate(overrides: Partial<ReflectorUpdate> = {}): ReflectorUpdate {
  return {
    subscription: "16",
    base: { source: "pubnet", asset: "XLM" },
    quote: { source: "exchanges", asset: "USD" },
    decimals: 14,
    price: "18700000000000",
    prevPrice: "18600000000000",
    timestamp: 1725578340000,
    ...overrides,
  };
}

function signedNotification(
  nodeKeypair: Keypair,
  update: ReflectorUpdate,
): ReflectorNotification {
  const hash = computeUpdateHash(update);
  return {
    update: { contract: "C...", events: [], event: update, root: "" },
    signature: nodeKeypair.sign(hash).toString("base64"),
    verifier: nodeKeypair.publicKey(),
  };
}

test("QuorumTracker rejects a notification with an invalid signature", () => {
  const node = Keypair.random();
  const tracker = new QuorumTracker([node.publicKey()], 1, 3600);
  const notification = signedNotification(node, sampleUpdate());
  notification.signature = "corrupted-signature-not-base64-real";
  const result = tracker.recordNotification(notification, 1000);
  assert.equal(result.status, "rejected-bad-signature");
});

test("QuorumTracker rejects a validly-signed notification from an untrusted verifier", () => {
  const trusted = Keypair.random();
  const untrusted = Keypair.random();
  const tracker = new QuorumTracker([trusted.publicKey()], 1, 3600);
  const notification = signedNotification(untrusted, sampleUpdate());
  const result = tracker.recordNotification(notification, 1000);
  assert.deepEqual(result, { status: "rejected-untrusted-verifier", verifier: untrusted.publicKey() });
});

test("QuorumTracker reaches quorum only once enough distinct trusted verifiers confirm the same event", () => {
  const nodeA = Keypair.random();
  const nodeB = Keypair.random();
  const nodeC = Keypair.random();
  const tracker = new QuorumTracker(
    [nodeA.publicKey(), nodeB.publicKey(), nodeC.publicKey()],
    2,
    3600,
  );
  const update = sampleUpdate();

  const first = tracker.recordNotification(signedNotification(nodeA, update), 1000);
  assert.equal(first.status, "recorded");
  if (first.status === "recorded") {
    assert.equal(first.needed, 1);
  }

  const second = tracker.recordNotification(signedNotification(nodeB, update), 1001);
  assert.equal(second.status, "quorum-reached");
  if (second.status === "quorum-reached") {
    assert.deepEqual(second.confirmingVerifiers.sort(), [nodeA.publicKey(), nodeB.publicKey()].sort());
  }

  const third = tracker.recordNotification(signedNotification(nodeC, update), 1002);
  assert.equal(third.status, "already-resolved");
});

test("QuorumTracker does not double-count a duplicate notification from the same verifier", () => {
  const nodeA = Keypair.random();
  const nodeB = Keypair.random();
  const tracker = new QuorumTracker([nodeA.publicKey(), nodeB.publicKey()], 2, 3600);
  const update = sampleUpdate();

  tracker.recordNotification(signedNotification(nodeA, update), 1000);
  const duplicate = tracker.recordNotification(signedNotification(nodeA, update), 1001);
  assert.equal(duplicate.status, "duplicate");

  // Still needs nodeB's real confirmation, nodeA repeating itself never
  // gets it there.
  const withB = tracker.recordNotification(signedNotification(nodeB, update), 1002);
  assert.equal(withB.status, "quorum-reached");
});

test("QuorumTracker tracks distinct events independently", () => {
  const nodeA = Keypair.random();
  const nodeB = Keypair.random();
  const tracker = new QuorumTracker([nodeA.publicKey(), nodeB.publicKey()], 2, 3600);
  const updateOne = sampleUpdate({ price: "1" });
  const updateTwo = sampleUpdate({ price: "2" });

  const r1 = tracker.recordNotification(signedNotification(nodeA, updateOne), 1000);
  assert.equal(r1.status, "recorded");
  const r2 = tracker.recordNotification(signedNotification(nodeA, updateTwo), 1000);
  assert.equal(r2.status, "recorded");
  if (r2.status === "recorded") {
    assert.equal(r2.confirmingVerifiers.length, 1);
  }
});

test("QuorumTracker prunes a group once its trust window has fully elapsed", () => {
  const nodeA = Keypair.random();
  const nodeB = Keypair.random();
  const tracker = new QuorumTracker([nodeA.publicKey(), nodeB.publicKey()], 2, 100);
  const update = sampleUpdate();

  tracker.recordNotification(signedNotification(nodeA, update), 1000);
  // nodeB's confirmation arrives well after the window: the stale group
  // was pruned, so this starts a fresh group needing quorum again rather
  // than completing the old one.
  const late = tracker.recordNotification(signedNotification(nodeB, update), 1000 + 500);
  assert.equal(late.status, "recorded");
});

test("QuorumTracker constructor rejects a quorum size larger than the trusted verifier set", () => {
  const node = Keypair.random();
  assert.throws(() => new QuorumTracker([node.publicKey()], 2, 3600));
});

test("QuorumTracker constructor rejects a quorum size below 1", () => {
  const node = Keypair.random();
  assert.throws(() => new QuorumTracker([node.publicKey()], 0, 3600));
});
