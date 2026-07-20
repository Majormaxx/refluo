// Small shared append-only JSONL log other loops write real events to
// and reporterLoop.ts reads back. Not a database: a single local file,
// consistent with the rest of this workspace's local-state convention
// (forecasterLoop.ts's own hysteresis state file). Any event whose
// authoritative source is real on-chain data (pause count/duration) is
// read straight from the chain instead of this log; this file exists
// only for events with no other real record, like exactly when a local
// loop first noticed a condition it then acted on.
import { appendFileSync, readFileSync, existsSync } from "node:fs";

export interface MetricEvent {
  type: string;
  timestampSeconds: number;
  [key: string]: unknown;
}

export function appendMetricEvent(filePath: string, event: MetricEvent): void {
  appendFileSync(filePath, `${JSON.stringify(event)}\n`);
}

/** Reads every well-formed event in the log. A single corrupted line
 * (e.g. a write torn by a crash mid-append) is skipped rather than
 * failing the whole read, since every other line is still real data. */
export function readMetricEvents(filePath: string): MetricEvent[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const events: MetricEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as MetricEvent);
    } catch {
      continue;
    }
  }
  return events;
}
