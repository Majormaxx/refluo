import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemState } from "risk-engine-client";
import { toBps, decideEscalation } from "./decision.js";

test("toBps converts Blend's 7-decimal utilization to 4-decimal bps", () => {
  assert.equal(toBps(8555000n), 8555); // 85.55%
  assert.equal(toBps(10000000n), 10000); // 100%
  assert.equal(toBps(0n), 0);
});

test("below both thresholds: no escalation", () => {
  const target = decideEscalation(5000, SystemState.Normal, 8500, 9200);
  assert.equal(target, null);
});

test("at preemptive threshold from Normal: escalates to PreemptiveDrain", () => {
  const target = decideEscalation(8500, SystemState.Normal, 8500, 9200);
  assert.equal(target, SystemState.PreemptiveDrain);
});

test("at full-drain threshold from Normal: escalates straight to Emergency, not PreemptiveDrain", () => {
  const target = decideEscalation(9500, SystemState.Normal, 8500, 9200);
  assert.equal(target, SystemState.Emergency);
});

test("between thresholds while already PreemptiveDrain: no further action, not stuck escalating repeatedly", () => {
  const target = decideEscalation(9000, SystemState.PreemptiveDrain, 8500, 9200);
  assert.equal(target, null);
});

test("already at Emergency: never re-escalates or downgrades, this loop is escalation-only", () => {
  const target = decideEscalation(9999, SystemState.Emergency, 8500, 9200);
  assert.equal(target, null);
});

test("already Paused: utilization never overrides a real guardian pause", () => {
  const target = decideEscalation(9999, SystemState.Paused, 8500, 9200);
  assert.equal(target, null);
});

test("utilization dropping back down never triggers a downgrade call", () => {
  // Recovery is a separate, deliberate keeper decision (adr/0006); this
  // loop must never call keeper_advance_state to move state down.
  const target = decideEscalation(100, SystemState.Emergency, 8500, 9200);
  assert.equal(target, null);
});
