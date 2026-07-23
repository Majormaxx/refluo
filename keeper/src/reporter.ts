// Reporter: pure SLA telemetry computation, no network or persistence
// here (that lives in reporterLoop.ts). Same split as forecaster.ts:
// testable without a real RPC connection. The four metrics the
// implementation spec names for this loop, restated in this workspace's
// own words: Tier 0 hit rate, recall latency, pause count/duration,
// Forecaster error (predicted vs realized).
import { winsorize, median, computeEwmas, type BurnObservation } from "./forecaster.js";

export interface Tier0Sample {
  timestampSeconds: number;
  balanceStroops: bigint;
  targetStroops: bigint;
  /** Optional, not required: real samples logged before this field
   * existed won't have it. computeAgentUptime excludes those rather than
   * guessing a threshold for them. */
  criticalFloorStroops?: bigint;
}

/** Fraction of samples where the real Tier 0 balance met or exceeded the
 * applied target at that moment: the SLA the whole sizing model exists to
 * satisfy. 1.0 with zero samples is deliberately not returned (there is
 * no evidence of anything having been hit), callers should treat an empty
 * sample set as "insufficient data", not a perfect score. */
export function computeTier0HitRate(samples: Tier0Sample[]): number {
  if (samples.length === 0) {
    return 0;
  }
  const hits = samples.filter((s) => s.balanceStroops >= s.targetStroops).length;
  return hits / samples.length;
}

/** "Agent uptime" (PRD §17's SLA metrics table): fraction of monitored
 * ticks where the real Tier 0 balance was at or above the vault's real
 * critical floor. This is a deliberately scoped-down version of the PRD's
 * literal definition ("% time funded above critical floor, excluding
 * manual top-ups") — no signal exists today to distinguish a manual
 * top-up from the agent's own automated recall, and inventing one would
 * be exactly the kind of fake precision this workspace's own doctrine
 * avoids. Samples with no logged critical floor (recorded before that
 * field existed) are excluded rather than guessed at. */
export function computeAgentUptime(samples: Tier0Sample[]): number {
  const withFloor = samples.filter((s) => s.criticalFloorStroops !== undefined);
  if (withFloor.length === 0) {
    return 0;
  }
  const above = withFloor.filter((s) => s.balanceStroops >= s.criticalFloorStroops!).length;
  return above / withFloor.length;
}

export interface PauseEvent {
  /** When the real Paused event landed. */
  pausedAtSeconds: number;
  /** The real pause_expiry field from the same event: the auto-expiry
   * ceiling this pause could never outlast even without a resume. */
  pauseExpirySeconds: number;
  /** When a real Resumed event (early=true) landed for this pause, if
   * one did, before natural expiry. */
  resumedAtSeconds: number | null;
}

export interface PauseStats {
  pauseCount: number;
  /** Real elapsed pause time, clipped to [windowStart, windowEnd] so a
   * pause that started before the window or is still open at its end
   * only counts the portion actually inside the reporting window. */
  totalPauseDurationSeconds: number;
}

/** Sums real, chain-observed pause durations within a reporting window.
 * A pause's real end is whichever comes first of a real early Resumed
 * event or the pause's own recorded auto-expiry (HealthMonitor's status()
 * itself clears lazily at expiry with no Resumed event required). */
export function computePauseStats(
  events: PauseEvent[],
  windowStartSeconds: number,
  windowEndSeconds: number,
): PauseStats {
  let totalPauseDurationSeconds = 0;
  let pauseCount = 0;
  for (const event of events) {
    const realEnd = event.resumedAtSeconds ?? event.pauseExpirySeconds;
    const clippedStart = Math.max(event.pausedAtSeconds, windowStartSeconds);
    const clippedEnd = Math.min(realEnd, windowEndSeconds);
    if (clippedEnd <= clippedStart) {
      continue;
    }
    pauseCount++;
    totalPauseDurationSeconds += clippedEnd - clippedStart;
  }
  return { pauseCount, totalPauseDurationSeconds };
}

export interface RecallLatencySample {
  /** When a real shortfall was first detected (a forecasterLoop tick
   * observed tier0 balance below the refill band). */
  detectedAtSeconds: number;
  /** When the real recall transaction it triggered actually landed
   * on-chain with SUCCESS. */
  executedAtSeconds: number;
}

export interface LatencyBucket {
  label: string;
  minSeconds: number;
  /** Exclusive upper bound; `null` means unbounded (the overflow bucket). */
  maxSeconds: number | null;
  count: number;
}

export interface LatencyHistogram {
  count: number;
  p50Seconds: number;
  p95Seconds: number;
  p99Seconds: number;
  buckets: LatencyBucket[];
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil((p / 100) * sortedValues.length) - 1,
  );
  return sortedValues[Math.max(0, index)];
}

/** Fixed bucket boundaries for the recall-latency histogram, in seconds.
 * `null` as the upper bound marks the overflow bucket. Chosen to span a
 * real recall's expected shape (most latency is one poll-interval plus
 * execution time, typically under a couple minutes) while still catching
 * a real outlier without an unbounded number of buckets. */
const RECALL_LATENCY_BUCKET_BOUNDS: Array<[number, number | null]> = [
  [0, 10],
  [10, 30],
  [30, 60],
  [60, 120],
  [120, 300],
  [300, null],
];

function bucketLabel(minSeconds: number, maxSeconds: number | null): string {
  return maxSeconds === null ? `${minSeconds}s+` : `${minSeconds}-${maxSeconds}s`;
}

function bucketLatencies(latencies: number[]): LatencyBucket[] {
  return RECALL_LATENCY_BUCKET_BOUNDS.map(([minSeconds, maxSeconds]) => ({
    label: bucketLabel(minSeconds, maxSeconds),
    minSeconds,
    maxSeconds,
    count: latencies.filter(
      (v) => v >= minSeconds && (maxSeconds === null || v < maxSeconds),
    ).length,
  }));
}

/** Latency from a real detected shortfall to a real executed recall
 * landing on-chain. In this workspace's own loop design the two are
 * usually the same tick (forecasterLoop detects and acts synchronously),
 * so this measures real wall-clock time to execute plus whatever real
 * poll-interval gap existed between the shortfall crossing and the next
 * tick noticing it, not a fabricated number. */
export function computeRecallLatencyHistogram(
  samples: RecallLatencySample[],
): LatencyHistogram {
  const latencies = samples
    .map((s) => s.executedAtSeconds - s.detectedAtSeconds)
    .filter((v) => v >= 0)
    .sort((a, b) => a - b);
  return {
    count: latencies.length,
    p50Seconds: percentile(latencies, 50),
    p95Seconds: percentile(latencies, 95),
    p99Seconds: percentile(latencies, 99),
    buckets: bucketLatencies(latencies),
  };
}

export interface ForecasterErrorSample {
  timestampSeconds: number;
  /** What the model would have predicted for this hour's burn rate
   * (stroops/hour), using only data available strictly before it. */
  predictedStroopsPerHour: number;
  /** What real chain history shows this hour's burn actually was. */
  realizedStroopsPerHour: number;
}

export interface ForecasterErrorStats {
  count: number;
  meanAbsErrorStroopsPerHour: number;
  /** Mean absolute percentage error, undefined entries (realized == 0)
   * excluded rather than producing an infinite/NaN contribution. */
  meanAbsPercentError: number;
  p99AbsErrorStroopsPerHour: number;
}

/** Backtests the sizing model's own predictions against what real chain
 * history shows actually happened, the "predicted vs realized P99" the
 * spec names. Every sample here has to come from a real prediction made
 * with only data available before the hour it predicts (reporterLoop's
 * job, not this pure function's), or this metric would be measuring the
 * model grading its own already-seen answers. */
export function computeForecasterError(
  samples: ForecasterErrorSample[],
): ForecasterErrorStats {
  if (samples.length === 0) {
    return {
      count: 0,
      meanAbsErrorStroopsPerHour: 0,
      meanAbsPercentError: 0,
      p99AbsErrorStroopsPerHour: 0,
    };
  }
  const absErrors = samples.map((s) =>
    Math.abs(s.predictedStroopsPerHour - s.realizedStroopsPerHour),
  );
  const pctErrors = samples
    .filter((s) => s.realizedStroopsPerHour !== 0)
    .map((s) =>
      Math.abs(
        (s.predictedStroopsPerHour - s.realizedStroopsPerHour) / s.realizedStroopsPerHour,
      ) * 100,
    );
  const sortedAbsErrors = [...absErrors].sort((a, b) => a - b);
  return {
    count: samples.length,
    meanAbsErrorStroopsPerHour: absErrors.reduce((a, b) => a + b, 0) / absErrors.length,
    meanAbsPercentError:
      pctErrors.length === 0 ? 0 : pctErrors.reduce((a, b) => a + b, 0) / pctErrors.length,
    p99AbsErrorStroopsPerHour: percentile(sortedAbsErrors, 99),
  };
}

/** Backtests the sizing model against real chain history: for each hour
 * in the backtest window, predicts that hour's burn rate using only
 * observations strictly before it (never the hour's own real value),
 * then compares against what really happened. A real generalization
 * check, not the model grading answers it already saw. */
export function backtestForecasterError(
  observations: BurnObservation[],
  backtestHours: number,
): ForecasterErrorSample[] {
  const samples: ForecasterErrorSample[] = [];
  const startIndex = Math.max(1, observations.length - backtestHours);
  for (let i = startIndex; i < observations.length; i++) {
    const priorSeries = observations.slice(0, i);
    if (priorSeries.length === 0) {
      continue;
    }
    const winsorizedPrior: number[] = [];
    for (let j = 0; j < priorSeries.length; j++) {
      const trailing = priorSeries.slice(Math.max(0, j - 168), j).map((o) => o.amountStroops);
      winsorizedPrior.push(Number(winsorize(priorSeries[j].amountStroops, median(trailing))));
    }
    const { fastPerHour, slowPerHour } = computeEwmas(winsorizedPrior);
    samples.push({
      timestampSeconds: observations[i].timestampSeconds,
      predictedStroopsPerHour: Math.max(fastPerHour, slowPerHour),
      realizedStroopsPerHour: Number(observations[i].amountStroops),
    });
  }
  return samples;
}

/** Evenly-spaced downsampling for chart series: always keeps the first
 * and last real point (so a chart's time axis never silently shrinks)
 * and picks real intermediate points at a fixed stride rather than
 * averaging/interpolating, so every plotted point is still a real
 * observation, never a synthesized one. */
export function downsampleSeries<T>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints || maxPoints <= 1) {
    return items;
  }
  const stride = (items.length - 1) / (maxPoints - 1);
  const picked: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    picked.push(items[Math.round(i * stride)]);
  }
  return picked;
}

/** Tier0Sample with bigint balances stringified for JSON transport (the
 * same string-bigint convention metricsLog.ts already uses), a real
 * point in the balance-vs-target series a chart plots directly. */
export interface Tier0SeriesPoint {
  timestampSeconds: number;
  balanceStroops: string;
  targetStroops: string;
}

export function toTier0SeriesPoints(samples: Tier0Sample[]): Tier0SeriesPoint[] {
  return samples.map((s) => ({
    timestampSeconds: s.timestampSeconds,
    balanceStroops: s.balanceStroops.toString(),
    targetStroops: s.targetStroops.toString(),
  }));
}

export interface SlaSnapshot {
  generatedAtSeconds: number;
  windowStartSeconds: number;
  windowEndSeconds: number;
  tier0HitRate: number;
  agentUptime: number;
  pauseStats: PauseStats;
  recallLatency: LatencyHistogram;
  forecasterError: ForecasterErrorStats;
  tier0Series: Tier0SeriesPoint[];
  forecasterErrorSeries: ForecasterErrorSample[];
}
