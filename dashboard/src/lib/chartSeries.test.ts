import { test } from "node:test";
import assert from "node:assert/strict";
import { toRangeSeries } from "./chartSeries";

test("toRangeSeries orders [min, max] when the low key really is lower", () => {
  const result = toRangeSeries([{ balance: 50, target: 100 }], "balance", "target");
  assert.deepEqual(result[0].range, [50, 100]);
});

test("toRangeSeries orders [min, max] even when the 'low' key is actually larger at this point", () => {
  // A real balance can sit above its target at some points in the window
  // — the range must still come out [min, max], not [lowKey, highKey].
  const result = toRangeSeries([{ balance: 150, target: 100 }], "balance", "target");
  assert.deepEqual(result[0].range, [100, 150]);
});

test("toRangeSeries handles equal values", () => {
  const result = toRangeSeries([{ predicted: 42, realized: 42 }], "predicted", "realized");
  assert.deepEqual(result[0].range, [42, 42]);
});

test("toRangeSeries preserves every other field on the point", () => {
  const result = toRangeSeries(
    [{ time: "Jul 21", balance: 10, target: 20 }],
    "balance",
    "target",
  );
  assert.equal(result[0].time, "Jul 21");
  assert.equal(result[0].balance, 10);
  assert.equal(result[0].target, 20);
});

test("toRangeSeries maps every point in a real multi-point series", () => {
  const result = toRangeSeries(
    [
      { predicted: 10, realized: 20 },
      { predicted: 30, realized: 5 },
    ],
    "predicted",
    "realized",
  );
  assert.deepEqual(result.map((r) => r.range), [
    [10, 20],
    [5, 30],
  ]);
});
