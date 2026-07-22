import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRiskProfileLabel } from "./riskProfile";

test("deriveRiskProfileLabel recognizes the real Conservative preset (contracts/risk-engine/src/lib.rs:126)", () => {
  assert.equal(
    deriveRiskProfileLabel({ preemptiveUtilBps: 7500, fullDrainUtilBps: 8500 }),
    "Conservative",
  );
});

test("deriveRiskProfileLabel recognizes the real Balanced preset (contracts/risk-engine/src/lib.rs:127)", () => {
  assert.equal(
    deriveRiskProfileLabel({ preemptiveUtilBps: 8500, fullDrainUtilBps: 9200 }),
    "Balanced",
  );
});

test("deriveRiskProfileLabel recognizes the real Aggressive preset (contracts/risk-engine/src/lib.rs:128)", () => {
  assert.equal(
    deriveRiskProfileLabel({ preemptiveUtilBps: 9000, fullDrainUtilBps: 9700 }),
    "Aggressive",
  );
});

test("deriveRiskProfileLabel returns Custom for a config that doesn't exactly match any preset", () => {
  assert.equal(
    deriveRiskProfileLabel({ preemptiveUtilBps: 8000, fullDrainUtilBps: 9000 }),
    "Custom",
  );
});

test("deriveRiskProfileLabel returns Custom when only one field happens to match a preset", () => {
  // preemptive matches Conservative's 7500, but full_drain doesn't match
  // Conservative's own 8500 — a real custom config, not a near-miss preset.
  assert.equal(
    deriveRiskProfileLabel({ preemptiveUtilBps: 7500, fullDrainUtilBps: 9700 }),
    "Custom",
  );
});
