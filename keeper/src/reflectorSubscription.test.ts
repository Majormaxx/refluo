import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  sortObjectKeys,
  computeUpdateHash,
  verifyNotificationSignature,
  crossCheckPrice,
  type ReflectorUpdate,
  type ReflectorNotification,
} from "./reflectorSubscription.js";

test("sortObjectKeys reorders top-level keys alphabetically", () => {
  const sorted = sortObjectKeys({ z: 1, a: 2, m: 3 }) as Record<string, number>;
  assert.deepEqual(Object.keys(sorted), ["a", "m", "z"]);
});

test("sortObjectKeys reorders nested object keys recursively", () => {
  const sorted = sortObjectKeys({ outer: { z: 1, a: 2 } }) as {
    outer: Record<string, number>;
  };
  assert.deepEqual(Object.keys(sorted.outer), ["a", "z"]);
});

test("sortObjectKeys maps arrays element-wise without sorting the array itself", () => {
  const sorted = sortObjectKeys([{ z: 1, a: 2 }, { b: 1 }]) as Array<Record<string, number>>;
  assert.deepEqual(Object.keys(sorted[0]), ["a", "z"]);
  assert.equal(sorted.length, 2);
});

test("sortObjectKeys passes primitives through unchanged", () => {
  assert.equal(sortObjectKeys(42), 42);
  assert.equal(sortObjectKeys("x"), "x");
  assert.equal(sortObjectKeys(null), null);
});

function sampleUpdate(): ReflectorUpdate {
  return {
    subscription: "16",
    base: { source: "pubnet", asset: "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
    quote: { source: "exchanges", asset: "SOL" },
    decimals: 14,
    price: "21749494669965161500",
    prevPrice: "21688544256328711209",
    timestamp: 1725578340000,
  };
}

test("computeUpdateHash is deterministic regardless of input field order", () => {
  const update = sampleUpdate();
  const reordered: ReflectorUpdate = {
    timestamp: update.timestamp,
    price: update.price,
    quote: update.quote,
    prevPrice: update.prevPrice,
    subscription: update.subscription,
    decimals: update.decimals,
    base: update.base,
  };
  assert.deepEqual(computeUpdateHash(update), computeUpdateHash(reordered));
});

test("computeUpdateHash changes when any field changes", () => {
  const update = sampleUpdate();
  const changed = { ...update, price: "1" };
  assert.notDeepEqual(computeUpdateHash(update), computeUpdateHash(changed));
});

test("verifyNotificationSignature accepts a real Ed25519 signature over the real preimage", () => {
  // A throwaway keypair standing in for a real Reflector node's own
  // signing key: the cryptographic scheme under test is the real one
  // (sortObjectKeys -> JSON.stringify -> sha256 -> Ed25519), copied
  // exactly from reflector-node's own source, only the key is local.
  const nodeKeypair = Keypair.random();
  const update = sampleUpdate();
  const hash = computeUpdateHash(update);
  const signature = nodeKeypair.sign(hash).toString("base64");

  const notification: ReflectorNotification = {
    update: {
      contract: "CBNGTWIVRCD4FOJ24FGAKI6I5SDAXI7A4GWKSQS7E6UYSR4E4OHRI2JX",
      events: [],
      event: update,
      root: "",
    },
    signature,
    verifier: nodeKeypair.publicKey(),
  };
  assert.equal(verifyNotificationSignature(notification), true);
});

test("verifyNotificationSignature rejects a signature from a different key", () => {
  const signerKeypair = Keypair.random();
  const impostorKeypair = Keypair.random();
  const update = sampleUpdate();
  const signature = signerKeypair.sign(computeUpdateHash(update)).toString("base64");

  const notification: ReflectorNotification = {
    update: { contract: "C...", events: [], event: update, root: "" },
    signature,
    verifier: impostorKeypair.publicKey(), // claims to be a different signer
  };
  assert.equal(verifyNotificationSignature(notification), false);
});

test("verifyNotificationSignature rejects a tampered update payload", () => {
  const nodeKeypair = Keypair.random();
  const update = sampleUpdate();
  const signature = nodeKeypair.sign(computeUpdateHash(update)).toString("base64");

  const tampered: ReflectorNotification = {
    update: {
      contract: "C...",
      events: [],
      event: { ...update, price: "1" }, // attacker changes the price after signing
      root: "",
    },
    signature,
    verifier: nodeKeypair.publicKey(),
  };
  assert.equal(verifyNotificationSignature(tampered), false);
});

test("verifyNotificationSignature fails closed on a malformed verifier key", () => {
  const notification: ReflectorNotification = {
    update: { contract: "C...", events: [], event: sampleUpdate(), root: "" },
    signature: "not-real-base64-signature",
    verifier: "not-a-real-stellar-address",
  };
  assert.equal(verifyNotificationSignature(notification), false);
});

test("crossCheckPrice does not flag a pause when prices agree closely", () => {
  const result = crossCheckPrice(18_700_000_000_000n, 14, 0.187, 500);
  assert.equal(result.shouldPause, false);
  assert.ok(result.divergenceBps < 500);
});

test("crossCheckPrice flags a pause when Reflector diverges from RedStone beyond the hard band", () => {
  // Reflector says $0.30, RedStone says $0.187: a real, large divergence.
  const result = crossCheckPrice(30_000_000_000_000n, 14, 0.187, 500);
  assert.equal(result.shouldPause, true);
  assert.ok(result.divergenceBps > 500);
});

test("crossCheckPrice reports the exact divergence in bps", () => {
  // reflector=$0.20, redstone=$0.10: exactly 100% = 10000bps divergence.
  const result = crossCheckPrice(20_000_000_000_000n, 14, 0.10, 500);
  assert.equal(result.divergenceBps, 10_000);
  assert.equal(result.shouldPause, true);
});
