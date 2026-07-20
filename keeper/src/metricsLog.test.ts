import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMetricEvent, readMetricEvents } from "./metricsLog.js";

function tempLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "refluo-metrics-test-"));
  return join(dir, "metrics.jsonl");
}

test("readMetricEvents returns an empty array for a nonexistent file", () => {
  assert.deepEqual(readMetricEvents(join(tmpdir(), "does-not-exist-refluo.jsonl")), []);
});

test("appendMetricEvent then readMetricEvents round-trips real events in order", () => {
  const path = tempLogPath();
  appendMetricEvent(path, { type: "a", timestampSeconds: 1 });
  appendMetricEvent(path, { type: "b", timestampSeconds: 2, extra: "value" });
  const events = readMetricEvents(path);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { type: "a", timestampSeconds: 1 });
  assert.deepEqual(events[1], { type: "b", timestampSeconds: 2, extra: "value" });
  rmSync(path, { force: true });
});

test("readMetricEvents skips a corrupted line rather than failing the whole read", () => {
  const path = tempLogPath();
  writeFileSync(path, '{"type":"good","timestampSeconds":1}\nnot-json\n{"type":"good2","timestampSeconds":2}\n');
  const events = readMetricEvents(path);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "good");
  assert.equal(events[1].type, "good2");
  rmSync(path, { force: true });
});
