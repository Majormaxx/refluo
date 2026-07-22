import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSessionToken, verifySessionToken, type SessionPayload } from "./session";

const SECRET = "test-secret-not-real";

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return { address: "GADDR", role: "admin", issuedAtSeconds: 1000, ...overrides };
}

test("issueSessionToken then verifySessionToken round-trips the real payload", () => {
  const token = issueSessionToken(payload(), SECRET);
  const verified = verifySessionToken(token, SECRET, 1000 + 10);
  assert.deepEqual(verified, payload());
});

test("verifySessionToken rejects a token signed with a different secret", () => {
  const token = issueSessionToken(payload(), SECRET);
  const verified = verifySessionToken(token, "wrong-secret", 1000 + 10);
  assert.equal(verified, null);
});

test("verifySessionToken rejects a tampered payload even with a valid-looking signature format", () => {
  const token = issueSessionToken(payload(), SECRET);
  const [, signature] = token.split(".");
  const tamperedPayload = Buffer.from(
    JSON.stringify(payload({ role: "guardian" })),
    "utf8",
  ).toString("base64url");
  const tamperedToken = `${tamperedPayload}.${signature}`;
  assert.equal(verifySessionToken(tamperedToken, SECRET, 1000 + 10), null);
});

test("verifySessionToken rejects an expired token", () => {
  const token = issueSessionToken(payload(), SECRET);
  const verified = verifySessionToken(token, SECRET, 1000 + 3601);
  assert.equal(verified, null);
});

test("verifySessionToken rejects a malformed token", () => {
  assert.equal(verifySessionToken("not-a-real-token", SECRET, 1000), null);
  assert.equal(verifySessionToken("a.b.c", SECRET, 1000), null);
  assert.equal(verifySessionToken("", SECRET, 1000), null);
});

test("verifySessionToken rejects a payload that isn't valid JSON", () => {
  const badPayloadB64 = Buffer.from("not json", "utf8").toString("base64url");
  const token = `${badPayloadB64}.somesignature`;
  assert.equal(verifySessionToken(token, SECRET, 1000), null);
});

test("issueSessionToken produces distinct tokens for admin vs guardian roles", () => {
  const adminToken = issueSessionToken(payload({ role: "admin" }), SECRET);
  const guardianToken = issueSessionToken(payload({ role: "guardian" }), SECRET);
  assert.notEqual(adminToken, guardianToken);
  assert.equal(verifySessionToken(guardianToken, SECRET, 1000 + 1)?.role, "guardian");
});
