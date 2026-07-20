// Reporter loop (adr/0019): real SLA telemetry, the implementation
// spec's own four metrics — Tier 0 hit rate, recall latency, pause
// count/duration, Forecaster error (predicted vs realized) — computed
// against real chain data and the real local metrics log
// forecasterLoop.ts writes to, not synthesized. "Ship to a dashboard" is
// the spec's own phrase; dashboard/ doesn't exist yet (separately
// tracked), so this writes the real computed snapshot to a local JSON
// file a dashboard can read once it does — the telemetry itself is real
// today, the web UI on top of it is a separate, already-tracked gap.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  computeTier0HitRate,
  computePauseStats,
  computeRecallLatencyHistogram,
  computeForecasterError,
  backtestForecasterError,
  type PauseEvent,
  type Tier0Sample,
  type RecallLatencySample,
  type SlaSnapshot,
} from "./reporter.js";
import { readMetricEvents } from "./metricsLog.js";
import { fetchHourlyBurnObservations } from "./forecasterLoop.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}, see .env.example`);
  }
  return value;
}

const RPC_URL = requireEnv("RPC_URL");
const HEALTH_MONITOR_ID = requireEnv("HEALTH_MONITOR_ID");
const METRICS_LOG_FILE = process.env.KEEPER_METRICS_LOG_FILE ?? ".keeper-metrics.jsonl";
const SNAPSHOT_FILE = process.env.REPORTER_SNAPSHOT_FILE ?? ".reporter-snapshot.json";
const WINDOW_HOURS = Number(process.env.REPORTER_WINDOW_HOURS ?? "168");
const FORECASTER_ERROR_BACKTEST_HOURS = Number(
  process.env.REPORTER_FORECASTER_ERROR_BACKTEST_HOURS ?? "72",
);

const SECONDS_PER_LEDGER_APPROX = 5;

const server = new rpc.Server(RPC_URL);

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/** Real Paused/Resumed events for HEALTH_MONITOR_ID over the reporting
 * window, decoded from the real event shape this workspace confirmed
 * live (topics: ["paused", [trigger_tag]] / ["resumed", early_bool],
 * value: {pause_expiry} / {}), not assumed from the contract source
 * alone. Pauses are paired chronologically: a real Resumed event closes
 * whichever real Paused came most recently before it. */
async function fetchPauseEvents(windowStartSeconds: number): Promise<PauseEvent[]> {
  const latestLedger = await server.getLatestLedger();
  const lookbackSeconds = Math.floor(Date.now() / 1000) - windowStartSeconds;
  const lookbackLedgers = Math.ceil(lookbackSeconds / SECONDS_PER_LEDGER_APPROX);
  const startLedger = Math.max(2, latestLedger.sequence - lookbackLedgers - 300);

  const pausedTopic = xdr.ScVal.scvSymbol("paused").toXDR("base64");
  const resumedTopic = xdr.ScVal.scvSymbol("resumed").toXDR("base64");

  type RawEvent = { closedAtSeconds: number; kind: "paused" | "resumed"; pauseExpiry?: number };
  const raw: RawEvent[] = [];

  let cursor: string | undefined;
  for (;;) {
    const response = await (cursor
      ? server.getEvents({
          filters: [
            {
              type: "contract",
              contractIds: [HEALTH_MONITOR_ID],
              topics: [
                [pausedTopic, "*"],
                [resumedTopic, "*"],
              ],
            },
          ],
          cursor,
          limit: 1000,
        })
      : server.getEvents({
          filters: [
            {
              type: "contract",
              contractIds: [HEALTH_MONITOR_ID],
              topics: [
                [pausedTopic, "*"],
                [resumedTopic, "*"],
              ],
            },
          ],
          startLedger,
          limit: 1000,
        }));

    for (const event of response.events) {
      const closedAtSeconds = Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000);
      const topicName = scValToNative(event.topic[0]) as string;
      if (topicName === "paused") {
        const data = scValToNative(event.value) as { pause_expiry: bigint };
        raw.push({ closedAtSeconds, kind: "paused", pauseExpiry: Number(data.pause_expiry) });
      } else if (topicName === "resumed") {
        raw.push({ closedAtSeconds, kind: "resumed" });
      }
    }

    if (response.events.length < 1000) {
      break;
    }
    cursor = response.cursor;
  }

  raw.sort((a, b) => a.closedAtSeconds - b.closedAtSeconds);

  const events: PauseEvent[] = [];
  let openPause: PauseEvent | null = null;
  for (const entry of raw) {
    if (entry.kind === "paused") {
      if (openPause) {
        events.push(openPause);
      }
      openPause = {
        pausedAtSeconds: entry.closedAtSeconds,
        pauseExpirySeconds: entry.pauseExpiry ?? entry.closedAtSeconds,
        resumedAtSeconds: null,
      };
    } else if (entry.kind === "resumed" && openPause) {
      openPause.resumedAtSeconds = entry.closedAtSeconds;
      events.push(openPause);
      openPause = null;
    }
  }
  if (openPause) {
    events.push(openPause);
  }
  return events;
}

function tier0SamplesFromLog(windowStartSeconds: number): Tier0Sample[] {
  return readMetricEvents(METRICS_LOG_FILE)
    .filter((e) => e.type === "tier0_sample" && e.timestampSeconds >= windowStartSeconds)
    .map((e) => ({
      timestampSeconds: e.timestampSeconds,
      balanceStroops: BigInt(e.balanceStroops as string),
      targetStroops: BigInt(e.targetStroops as string),
    }));
}

function recallLatencySamplesFromLog(windowStartSeconds: number): RecallLatencySample[] {
  return readMetricEvents(METRICS_LOG_FILE)
    .filter((e) => e.type === "recall_triggered" && e.timestampSeconds >= windowStartSeconds)
    .map((e) => ({
      detectedAtSeconds: e.detectedAtSeconds as number,
      executedAtSeconds: e.executedAtSeconds as number,
    }));
}

export async function tick(): Promise<SlaSnapshot> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStartSeconds = nowSeconds - WINDOW_HOURS * 3600;

  log(`computing SLA telemetry over the trailing ${WINDOW_HOURS}h`);

  const pauseEvents = await fetchPauseEvents(windowStartSeconds);
  const pauseStats = computePauseStats(pauseEvents, windowStartSeconds, nowSeconds);
  log(`real pause events: count=${pauseStats.pauseCount} totalDurationSeconds=${pauseStats.totalPauseDurationSeconds}`);

  const tier0Samples = tier0SamplesFromLog(windowStartSeconds);
  const tier0HitRate = computeTier0HitRate(tier0Samples);
  log(`tier0 hit rate over ${tier0Samples.length} real samples: ${(tier0HitRate * 100).toFixed(1)}%`);

  const recallSamples = recallLatencySamplesFromLog(windowStartSeconds);
  const recallLatency = computeRecallLatencyHistogram(recallSamples);
  log(`recall latency over ${recallLatency.count} real samples: p50=${recallLatency.p50Seconds}s p99=${recallLatency.p99Seconds}s`);

  const observations = await fetchHourlyBurnObservations();
  const forecasterErrorSamples = backtestForecasterError(
    observations,
    FORECASTER_ERROR_BACKTEST_HOURS,
  );
  const forecasterError = computeForecasterError(forecasterErrorSamples);
  log(
    `forecaster error over ${forecasterError.count} real backtested hours: ` +
      `meanAbsPct=${forecasterError.meanAbsPercentError.toFixed(1)}% p99Abs=${forecasterError.p99AbsErrorStroopsPerHour.toFixed(0)}/hr`,
  );

  const snapshot: SlaSnapshot = {
    generatedAtSeconds: nowSeconds,
    windowStartSeconds,
    windowEndSeconds: nowSeconds,
    tier0HitRate,
    pauseStats,
    recallLatency,
    forecasterError,
  };
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  log(`wrote SLA snapshot to ${SNAPSHOT_FILE}`);
  return snapshot;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  const pollSeconds = Number(process.env.REPORTER_POLL_INTERVAL_SECONDS ?? "3600");
  log(`reporter starting, polling every ${pollSeconds}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { fetchPauseEvents };
