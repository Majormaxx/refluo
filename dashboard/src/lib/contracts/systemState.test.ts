import { test } from "node:test";
import assert from "node:assert/strict";
import { SystemState } from "dashboard-risk-engine-client";
import { decodeSystemState } from "./systemState";

test("decodeSystemState decodes the real Normal value", () => {
  assert.equal(decodeSystemState(SystemState.Normal), "Normal");
});

test("decodeSystemState decodes the real PreemptiveDrain value", () => {
  assert.equal(decodeSystemState(SystemState.PreemptiveDrain), "PreemptiveDrain");
});

test("decodeSystemState decodes the real Emergency value", () => {
  assert.equal(decodeSystemState(SystemState.Emergency), "Emergency");
});

test("decodeSystemState decodes the real Paused value", () => {
  assert.equal(decodeSystemState(SystemState.Paused), "Paused");
});

test("decodeSystemState throws naming the bad value for an unrecognized enum number", () => {
  assert.throws(
    () => decodeSystemState(4 as SystemState),
    /RiskEngine returned an unrecognized SystemState value: 4/,
  );
});
