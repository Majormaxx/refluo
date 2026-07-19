import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSwap, oracleDerivedMinOut } from "./swapDecision.js";

const PRICE_10C = 10_000_000_000_000n; // $0.10, 14 decimals
const FLOOR = 100_000_0000n; // 100 XLM
const TARGET = 500_000_0000n; // 500 XLM

test("balance above floor: no swap needed", () => {
  const need = decideSwap(200_000_0000n, FLOOR, TARGET, PRICE_10C, 9700);
  assert.equal(need, null);
});

test("balance exactly at floor: no swap needed, floor is inclusive", () => {
  const need = decideSwap(FLOOR, FLOOR, TARGET, PRICE_10C, 9700);
  assert.equal(need, null);
});

test("balance below floor: proposes a swap sized to reach the target", () => {
  const need = decideSwap(50_000_0000n, FLOOR, TARGET, PRICE_10C, 9700);
  assert.notEqual(need, null);
  // shortfall = 500 - 50 = 450 XLM, at $0.10/XLM = 45 USDC.
  assert.equal(need!.amountInUsdcStroops, 45_000_0000n);
});

test("amountOutMinXlmStroops is min_out_bps of the oracle-fair output, never looser", () => {
  const need = decideSwap(0n, FLOOR, TARGET, PRICE_10C, 9700);
  assert.notEqual(need, null);
  // 500 XLM shortfall at $0.10 = 50 USDC in; fair XLM out = 500 XLM;
  // floor at 9700bps = 485 XLM.
  assert.equal(need!.amountInUsdcStroops, 50_000_0000n);
  assert.equal(need!.amountOutMinXlmStroops, 485_000_0000n);
});

test("higher min_out_bps produces a tighter (larger) amount_out_min", () => {
  const loose = decideSwap(0n, FLOOR, TARGET, PRICE_10C, 9000)!;
  const tight = decideSwap(0n, FLOOR, TARGET, PRICE_10C, 9900)!;
  assert.ok(tight.amountOutMinXlmStroops > loose.amountOutMinXlmStroops);
});

test("higher XLM price means more USDC needed to buy back the same shortfall", () => {
  const cheap = decideSwap(0n, FLOOR, TARGET, 10_000_000_000_000n, 9700)!; // $0.10
  const expensive = decideSwap(0n, FLOOR, TARGET, 100_000_000_000_000n, 9700)!; // $1.00
  assert.ok(expensive.amountInUsdcStroops > cheap.amountInUsdcStroops);
});

test("rejects a misconfigured target at or below the floor", () => {
  assert.throws(() => decideSwap(0n, FLOOR, FLOOR, PRICE_10C, 9700));
  assert.throws(() => decideSwap(0n, TARGET, FLOOR, PRICE_10C, 9700));
});

test("oracleDerivedMinOut rejects a non-positive price", () => {
  assert.throws(() => oracleDerivedMinOut(1_000_0000n, 0n, 9700));
  assert.throws(() => oracleDerivedMinOut(1_000_0000n, -1n, 9700));
});

test("oracleDerivedMinOut round-trips against decideSwap's own amount_in", () => {
  const need = decideSwap(0n, FLOOR, TARGET, PRICE_10C, 9700)!;
  const recomputed = oracleDerivedMinOut(need.amountInUsdcStroops, PRICE_10C, 9700);
  assert.equal(recomputed, need.amountOutMinXlmStroops);
});
