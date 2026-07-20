import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeTier0HitRate,
  computePauseStats,
  computeRecallLatencyHistogram,
  computeForecasterError,
  backtestForecasterError,
} from "./reporter.js";
import type { BurnObservation } from "./forecaster.js";

test("computeTier0HitRate is 0 with no samples, not a false perfect score", () => {
  assert.equal(computeTier0HitRate([]), 0);
});

test("computeTier0HitRate is 1.0 when balance always met or exceeded target", () => {
  const rate = computeTier0HitRate([
    { timestampSeconds: 1, balanceStroops: 100n, targetStroops: 100n },
    { timestampSeconds: 2, balanceStroops: 150n, targetStroops: 100n },
  ]);
  assert.equal(rate, 1);
});

test("computeTier0HitRate reflects the real fraction of hits", () => {
  const rate = computeTier0HitRate([
    { timestampSeconds: 1, balanceStroops: 100n, targetStroops: 100n },
    { timestampSeconds: 2, balanceStroops: 50n, targetStroops: 100n },
    { timestampSeconds: 3, balanceStroops: 50n, targetStroops: 100n },
    { timestampSeconds: 4, balanceStroops: 200n, targetStroops: 100n },
  ]);
  assert.equal(rate, 0.5);
});

test("computePauseStats counts a pause fully inside the window", () => {
  const stats = computePauseStats(
    [{ pausedAtSeconds: 100, pauseExpirySeconds: 100 + 72 * 3600, resumedAtSeconds: 200 }],
    0,
    1000,
  );
  assert.equal(stats.pauseCount, 1);
  assert.equal(stats.totalPauseDurationSeconds, 100);
});

test("computePauseStats clips a pause that started before the window", () => {
  const stats = computePauseStats(
    [{ pausedAtSeconds: -50, pauseExpirySeconds: 1000, resumedAtSeconds: 50 }],
    0,
    1000,
  );
  assert.equal(stats.totalPauseDurationSeconds, 50);
});

test("computePauseStats falls back to real auto-expiry when never resumed", () => {
  const stats = computePauseStats(
    [{ pausedAtSeconds: 0, pauseExpirySeconds: 500, resumedAtSeconds: null }],
    0,
    1000,
  );
  assert.equal(stats.totalPauseDurationSeconds, 500);
});

test("computePauseStats excludes a pause entirely outside the window", () => {
  const stats = computePauseStats(
    [{ pausedAtSeconds: 2000, pauseExpirySeconds: 2100, resumedAtSeconds: 2050 }],
    0,
    1000,
  );
  assert.equal(stats.pauseCount, 0);
  assert.equal(stats.totalPauseDurationSeconds, 0);
});

test("computePauseStats sums multiple real pauses in the window", () => {
  const stats = computePauseStats(
    [
      { pausedAtSeconds: 0, pauseExpirySeconds: 100, resumedAtSeconds: 50 },
      { pausedAtSeconds: 200, pauseExpirySeconds: 400, resumedAtSeconds: 300 },
    ],
    0,
    1000,
  );
  assert.equal(stats.pauseCount, 2);
  assert.equal(stats.totalPauseDurationSeconds, 150);
});

test("computeRecallLatencyHistogram returns zeroed stats with no samples", () => {
  const hist = computeRecallLatencyHistogram([]);
  assert.deepEqual(hist, { count: 0, p50Seconds: 0, p95Seconds: 0, p99Seconds: 0 });
});

test("computeRecallLatencyHistogram computes real percentiles over recorded latencies", () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({
    detectedAtSeconds: 0,
    executedAtSeconds: i + 1, // latencies 1..100 seconds
  }));
  const hist = computeRecallLatencyHistogram(samples);
  assert.equal(hist.count, 100);
  assert.equal(hist.p50Seconds, 50);
  assert.equal(hist.p95Seconds, 95);
  assert.equal(hist.p99Seconds, 99);
});

test("computeRecallLatencyHistogram ignores a negative (clock-skew) latency", () => {
  const hist = computeRecallLatencyHistogram([{ detectedAtSeconds: 100, executedAtSeconds: 50 }]);
  assert.equal(hist.count, 0);
});

test("computeForecasterError returns zeroed stats with no samples", () => {
  const stats = computeForecasterError([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.meanAbsErrorStroopsPerHour, 0);
});

test("computeForecasterError is zero when predictions exactly match reality", () => {
  const stats = computeForecasterError([
    { timestampSeconds: 1, predictedStroopsPerHour: 100, realizedStroopsPerHour: 100 },
    { timestampSeconds: 2, predictedStroopsPerHour: 50, realizedStroopsPerHour: 50 },
  ]);
  assert.equal(stats.meanAbsErrorStroopsPerHour, 0);
  assert.equal(stats.meanAbsPercentError, 0);
});

test("computeForecasterError reports real mean absolute and percentage error", () => {
  const stats = computeForecasterError([
    { timestampSeconds: 1, predictedStroopsPerHour: 110, realizedStroopsPerHour: 100 },
    { timestampSeconds: 2, predictedStroopsPerHour: 90, realizedStroopsPerHour: 100 },
  ]);
  assert.equal(stats.meanAbsErrorStroopsPerHour, 10);
  assert.equal(stats.meanAbsPercentError, 10);
});

test("computeForecasterError excludes a zero-realized sample from percent error but keeps it in absolute error", () => {
  const stats = computeForecasterError([
    { timestampSeconds: 1, predictedStroopsPerHour: 10, realizedStroopsPerHour: 0 },
    { timestampSeconds: 2, predictedStroopsPerHour: 100, realizedStroopsPerHour: 100 },
  ]);
  assert.equal(stats.count, 2);
  assert.equal(stats.meanAbsErrorStroopsPerHour, 5);
  // Only the second sample has a defined percent error (0%).
  assert.equal(stats.meanAbsPercentError, 0);
});

function hourlyObservations(amountsStroops: number[]): BurnObservation[] {
  const startSeconds = 1_700_000_000;
  return amountsStroops.map((amount, i) => ({
    timestampSeconds: startSeconds + i * 3600,
    amountStroops: BigInt(amount),
  }));
}

test("backtestForecasterError produces no samples with fewer than two real hourly buckets", () => {
  assert.deepEqual(backtestForecasterError(hourlyObservations([100]), 72), []);
  assert.deepEqual(backtestForecasterError([], 72), []);
});

test("backtestForecasterError predicts each hour using only strictly-prior data", () => {
  // A flat, constant series: after the model has seen the first hour,
  // every later hour's prediction should closely match that same
  // constant, real generalization on a trivial series.
  const observations = hourlyObservations(Array(10).fill(1000));
  const samples = backtestForecasterError(observations, 72);
  assert.equal(samples.length, 9); // every hour except the first, which has no prior data
  for (const sample of samples) {
    assert.equal(sample.realizedStroopsPerHour, 1000);
    assert.ok(
      Math.abs(sample.predictedStroopsPerHour - 1000) < 1,
      `expected prediction near 1000, got ${sample.predictedStroopsPerHour}`,
    );
  }
});

test("backtestForecasterError never lets a later hour's real value leak into an earlier prediction", () => {
  // A single huge spike on the very last hour: since every prediction
  // uses only strictly-prior data, no prediction before the spike's own
  // index should be affected by it at all.
  const amounts = Array(20).fill(100);
  amounts[19] = 1_000_000;
  const observations = hourlyObservations(amounts);
  const samples = backtestForecasterError(observations, 72);
  // The last sample (predicting the spike hour) is predicted from prior
  // (unspiked) data, so its predicted value should be far below the
  // spike's own realized value.
  const lastSample = samples[samples.length - 1];
  assert.equal(lastSample.realizedStroopsPerHour, 1_000_000);
  assert.ok(lastSample.predictedStroopsPerHour < 100_000);
});

test("backtestForecasterError respects the backtestHours window, not the full history", () => {
  const observations = hourlyObservations(Array(200).fill(50));
  const samples = backtestForecasterError(observations, 24);
  assert.equal(samples.length, 24);
});
