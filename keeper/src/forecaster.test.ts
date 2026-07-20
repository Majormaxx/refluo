import { test } from "node:test";
import assert from "node:assert/strict";
import {
  winsorize,
  median,
  halfLifeToAlpha,
  ewmaStep,
  computeEwmas,
  computeTier0Target,
  applyHysteresis,
  shouldWriteOnChain,
  shouldRecall,
} from "./forecaster.js";

test("winsorize passes through a value at or below 3x the trailing median", () => {
  assert.equal(winsorize(300n, 100n), 300n);
  assert.equal(winsorize(150n, 100n), 150n);
});

test("winsorize clips a value above 3x the trailing median", () => {
  assert.equal(winsorize(1000n, 100n), 300n);
});

test("winsorize passes a value through unclipped when the trailing median is zero (no history yet)", () => {
  assert.equal(winsorize(500n, 0n), 500n);
});

test("median of an odd-length array is the middle element", () => {
  assert.equal(median([3n, 1n, 2n]), 2n);
});

test("median of an even-length array averages the two middle elements", () => {
  assert.equal(median([1n, 2n, 3n, 4n]), 2n); // (2+3)/2 = 2 (bigint division)
});

test("median of an empty array is zero", () => {
  assert.equal(median([]), 0n);
});

test("halfLifeToAlpha: after one half-life, weight on the new observation is 50%", () => {
  const alpha = halfLifeToAlpha(6);
  // ewmaStep applied `halfLife` times starting from 0 should leave the
  // previous value's remaining weight at (1-alpha)^halfLife ~= 0.5.
  let value = 100;
  for (let i = 0; i < 6; i++) {
    value = ewmaStep(value, 0, alpha);
  }
  assert.ok(Math.abs(value - 50) < 1, `expected ~50, got ${value}`);
});

test("halfLifeToAlpha rejects a non-positive half-life", () => {
  assert.throws(() => halfLifeToAlpha(0));
  assert.throws(() => halfLifeToAlpha(-1));
});

test("ewmaStep seeds directly from the first observation", () => {
  assert.equal(ewmaStep(null, 42, 0.5), 42);
});

test("computeEwmas: after a step change, the fast EWMA tracks it more closely than the slow one", () => {
  // A pure constant series converges both EWMAs to that constant after a
  // single step regardless of alpha, so a step function (quiet, then a
  // sustained new level) is what actually exercises half-life behavior.
  const series = [...new Array(200).fill(0), ...new Array(24).fill(100)];
  const { fastPerHour, slowPerHour } = computeEwmas(series);
  assert.ok(fastPerHour > slowPerHour);
  // fast (6h half-life) has had 4 full half-lives at the new level, well
  // over halfway there.
  assert.ok(fastPerHour > 80);
  // slow (7d = 168h half-life) has had under 1 half-life at the new
  // level, nowhere near halfway there yet.
  assert.ok(slowPerHour < 15);
});

test("computeEwmas returns zero for both when there is no history", () => {
  const { fastPerHour, slowPerHour } = computeEwmas([]);
  assert.equal(fastPerHour, 0);
  assert.equal(slowPerHour, 0);
});

test("computeEwmas: fast reacts to a recent spike more than slow does", () => {
  const quiet = new Array(200).fill(10);
  const spike = [...quiet, 1000];
  const { fastPerHour, slowPerHour } = computeEwmas(spike);
  assert.ok(fastPerHour > slowPerHour);
});

test("computeTier0Target uses the larger of fast/slow, scaled by recall window and k, plus the fee floor", () => {
  const target = computeTier0Target({
    fastPerHourStroops: 720_000, // 200 stroops/sec
    slowPerHourStroops: 360_000, // 100 stroops/sec
    recallWindowSeconds: 3600,
    k: 1,
    xlmFeeFloorUsdStroops: 1_000_000n,
  });
  // max(fast,slow) = 720_000/hr = 200/sec; 200 * 3600 * 1 = 720_000; + 1_000_000
  assert.equal(target, 1_720_000n);
});

test("computeTier0Target scales linearly with k", () => {
  const base = {
    fastPerHourStroops: 720_000,
    slowPerHourStroops: 0,
    recallWindowSeconds: 3600,
    xlmFeeFloorUsdStroops: 0n,
  };
  const k1 = computeTier0Target({ ...base, k: 1 });
  const k2 = computeTier0Target({ ...base, k: 2 });
  assert.equal(k2, k1 * 2n);
});

test("applyHysteresis raises immediately when the computed target is higher", () => {
  const decision = applyHysteresis(200n, 100n, 1_000_000, { belowSinceSeconds: null });
  assert.equal(decision.appliedTarget, 200n);
  assert.equal(decision.nextState.belowSinceSeconds, null);
});

test("applyHysteresis holds the on-chain target on the first tick a decline is observed", () => {
  const decision = applyHysteresis(50n, 100n, 1_000_000, { belowSinceSeconds: null });
  assert.equal(decision.appliedTarget, 100n);
  assert.equal(decision.nextState.belowSinceSeconds, 1_000_000);
});

test("applyHysteresis keeps holding while the decline has not been sustained 24h", () => {
  const decision = applyHysteresis(50n, 100n, 1_000_000 + 3600, {
    belowSinceSeconds: 1_000_000,
  });
  assert.equal(decision.appliedTarget, 100n);
  assert.equal(decision.nextState.belowSinceSeconds, 1_000_000);
});

test("applyHysteresis lowers once the decline has been sustained a full 24h", () => {
  const decision = applyHysteresis(50n, 100n, 1_000_000 + 24 * 3600, {
    belowSinceSeconds: 1_000_000,
  });
  assert.equal(decision.appliedTarget, 50n);
  assert.equal(decision.nextState.belowSinceSeconds, null);
});

test("applyHysteresis resets the below-timer if the target recovers above on-chain before 24h", () => {
  const dipped = applyHysteresis(50n, 100n, 1_000_000, { belowSinceSeconds: null });
  const recovered = applyHysteresis(150n, 100n, 1_000_100, dipped.nextState);
  assert.equal(recovered.appliedTarget, 150n);
  assert.equal(recovered.nextState.belowSinceSeconds, null);
});

test("shouldWriteOnChain is false for a change within the band", () => {
  assert.equal(shouldWriteOnChain(10_400n, 10_000n, 500), false); // 4% < 5% band
});

test("shouldWriteOnChain is true for a change beyond the band", () => {
  assert.equal(shouldWriteOnChain(10_600n, 10_000n, 500), true); // 6% > 5% band
});

test("shouldWriteOnChain treats any nonzero proposal as beyond the band when on-chain is zero", () => {
  assert.equal(shouldWriteOnChain(1n, 0n, 500), true);
  assert.equal(shouldWriteOnChain(0n, 0n, 500), false);
});

test("shouldRecall is true when tier0 balance is below the refill band of the target", () => {
  assert.equal(shouldRecall(1_000n, 10_000n, 2_000), true); // 1000 < 20% of 10000
});

test("shouldRecall is false when tier0 balance is at or above the refill band", () => {
  assert.equal(shouldRecall(2_000n, 10_000n, 2_000), false);
  assert.equal(shouldRecall(5_000n, 10_000n, 2_000), false);
});
