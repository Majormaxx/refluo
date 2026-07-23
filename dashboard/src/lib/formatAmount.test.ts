import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStroops } from "./formatAmount";

test("formatStroops converts a whole-number amount and labels the real asset", () => {
  assert.equal(formatStroops("100000000000", "USDC"), "10,000 USDC");
});

test("formatStroops converts a fractional amount, trimmed to maximumFractionDigits", () => {
  assert.equal(formatStroops("12345678", "XLM"), "1.23 XLM");
});

test("formatStroops respects a custom maximumFractionDigits", () => {
  assert.equal(formatStroops("12345678", "XLM", 4), "1.2346 XLM");
});

test("formatStroops handles zero", () => {
  assert.equal(formatStroops("0", "USDC"), "0 USDC");
});

test("formatStroops accepts a real bigint input, not just a string", () => {
  assert.equal(formatStroops(BigInt(50_000_000_000), "USDC"), "5,000 USDC");
});

test("formatStroops stays accurate at this system's real operating scale (tens of billions of stroops), documenting the Number.MAX_SAFE_INTEGER display-only tradeoff", () => {
  // Real Tier0 bounds seen in this codebase's own test fixtures/live
  // deployments are in the tens of billions of stroops (tens of
  // thousands of USDC) — nowhere near Number.MAX_SAFE_INTEGER (2^53-1),
  // so the Number() conversion this display util relies on is exact here.
  assert.equal(formatStroops("200000000000", "USDC"), "20,000 USDC");
  assert.ok(200_000_000_000 < Number.MAX_SAFE_INTEGER);
});

test("formatStroops omits the unit suffix when unit is null", () => {
  assert.equal(formatStroops("100000000000", null, 0), "10,000");
});
