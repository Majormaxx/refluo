import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createChallenge,
  challengeMessage,
  isChallengeExpired,
  sep53Hash,
  verifySep53Signature,
  verifyChallengeResponse,
  SEP53_PREFIX,
} from "./challenge";

test("SEP53_PREFIX matches Freighter's own real prefix exactly", () => {
  assert.equal(SEP53_PREFIX, "Stellar Signed Message:\n");
});

test("sep53Hash is deterministic for the same message", () => {
  assert.deepEqual(sep53Hash("hello"), sep53Hash("hello"));
});

test("sep53Hash differs for different messages", () => {
  assert.notDeepEqual(sep53Hash("hello"), sep53Hash("world"));
});

test("verifySep53Signature accepts a real Ed25519 signature over the real SEP-53 preimage", () => {
  const keypair = Keypair.random();
  const message = "test message";
  const signature = keypair.sign(sep53Hash(message));
  assert.equal(verifySep53Signature(message, signature, keypair.publicKey()), true);
});

test("verifySep53Signature rejects a signature from a different key", () => {
  const signer = Keypair.random();
  const impostor = Keypair.random();
  const message = "test message";
  const signature = signer.sign(sep53Hash(message));
  assert.equal(verifySep53Signature(message, signature, impostor.publicKey()), false);
});

test("verifySep53Signature rejects a tampered message", () => {
  const keypair = Keypair.random();
  const signature = keypair.sign(sep53Hash("original"));
  assert.equal(verifySep53Signature("tampered", signature, keypair.publicKey()), false);
});

test("verifySep53Signature fails closed on a malformed address", () => {
  const keypair = Keypair.random();
  const signature = keypair.sign(sep53Hash("m"));
  assert.equal(verifySep53Signature("m", signature, "not-a-real-address"), false);
});

test("createChallenge produces a fresh nonce each call", () => {
  const a = createChallenge("GADDR", 1000);
  const b = createChallenge("GADDR", 1000);
  assert.notEqual(a.nonce, b.nonce);
});

test("challengeMessage embeds the address and nonce so a signer can review what they're signing", () => {
  const challenge = createChallenge("GADDR", 1000);
  const message = challengeMessage(challenge);
  assert.ok(message.includes("GADDR"));
  assert.ok(message.includes(challenge.nonce));
});

test("isChallengeExpired is false within the TTL and true beyond it", () => {
  const challenge = createChallenge("GADDR", 1000);
  assert.equal(isChallengeExpired(challenge, 1000 + 60), false);
  assert.equal(isChallengeExpired(challenge, 1000 + 301), true);
});

test("verifyChallengeResponse accepts a real signature over the real challenge message within the TTL", () => {
  const keypair = Keypair.random();
  const challenge = createChallenge(keypair.publicKey(), 1000);
  const signature = keypair.sign(sep53Hash(challengeMessage(challenge)));
  assert.equal(verifyChallengeResponse(challenge, signature, 1000 + 10), true);
});

test("verifyChallengeResponse rejects a real signature once the challenge has expired", () => {
  const keypair = Keypair.random();
  const challenge = createChallenge(keypair.publicKey(), 1000);
  const signature = keypair.sign(sep53Hash(challengeMessage(challenge)));
  assert.equal(verifyChallengeResponse(challenge, signature, 1000 + 400), false);
});

test("verifyChallengeResponse rejects a signature over a different challenge (replay across nonces)", () => {
  const keypair = Keypair.random();
  const challengeA = createChallenge(keypair.publicKey(), 1000);
  const challengeB = createChallenge(keypair.publicKey(), 1000);
  const signatureForA = keypair.sign(sep53Hash(challengeMessage(challengeA)));
  assert.equal(verifyChallengeResponse(challengeB, signatureForA, 1000 + 10), false);
});
