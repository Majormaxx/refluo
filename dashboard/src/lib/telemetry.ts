// SLA telemetry panel (PRD 8.2): "the keeper reporter loop's output
// surfaced directly." keeper/src/reporterLoop.ts (adr/0019) already
// computes the real SlaSnapshot and writes it to a local JSON file; this
// dashboard reads that same real file rather than recomputing anything,
// so the two processes' shared deployment host (or a shared volume) is
// the real integration point, documented in .env.example. No mock
// telemetry is fabricated if the file is missing — an honest "reporter
// hasn't run yet" state is returned instead.
import "server-only";
import { readFileSync, existsSync } from "node:fs";
import { optionalEnv } from "./env";

const SNAPSHOT_FILE = optionalEnv("REPORTER_SNAPSHOT_FILE", "../keeper/.reporter-snapshot.json");

export interface SlaLatencyBucket {
  label: string;
  minSeconds: number;
  maxSeconds: number | null;
  count: number;
}

export interface SlaTier0SeriesPoint {
  timestampSeconds: number;
  balanceStroops: string;
  targetStroops: string;
}

export interface SlaForecasterErrorSeriesPoint {
  timestampSeconds: number;
  predictedStroopsPerHour: number;
  realizedStroopsPerHour: number;
}

export interface SlaSnapshot {
  generatedAtSeconds: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
  tier0HitRate: number;
  pauseStats: { pauseCount: number; totalPauseDurationSeconds: number };
  recallLatency: {
    count: number;
    p50Seconds: number;
    p95Seconds: number;
    p99Seconds: number;
    buckets: SlaLatencyBucket[];
  };
  forecasterError: {
    count: number;
    meanAbsErrorStroopsPerHour: number;
    meanAbsPercentError: number;
    p99AbsErrorStroopsPerHour: number;
  };
  tier0Series: SlaTier0SeriesPoint[];
  forecasterErrorSeries: SlaForecasterErrorSeriesPoint[];
}

export function readSlaSnapshot(): SlaSnapshot | null {
  if (!existsSync(SNAPSHOT_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as SlaSnapshot;
  } catch {
    return null;
  }
}
