// Forecaster: Tier 0 sizing. Pure logic, no network or persistence here
// (that lives in forecasterLoop.ts), so the model is testable without a
// real RPC connection or a funded keeper key.
//
// target = max(fast_ewma, slow_ewma) * recall_window * k + xlm_fee_floor_usd
//
// fast/slow are burn-rate EWMAs (USDC stroops per second) computed over
// winsorized hourly burn observations. `k` is an operator-set buffer
// multiplier (how many recall windows of headroom to hold above the raw
// P99 estimate); this workspace does not hardcode a fixed value per risk
// profile the way RiskEngine's own on-chain utilization thresholds are
// hardcoded (adr/0013), Tier 0 sizing runs off-chain and RiskEngine's own
// tier0_bounds_min/max remain the on-chain safety net regardless of what
// value the Forecaster proposes. `xlm_fee_floor_usd` is a USDC-equivalent
// buffer, not an XLM amount: it is what lets Tier 0's own target absorb a
// real XLM top-up swap (adr/0015) without dipping below its own minimum.

export interface BurnObservation {
  /** Unix seconds, aligned to an hour boundary. */
  timestampSeconds: number;
  /** USDC stroops burned in this hour. */
  amountStroops: bigint;
}

/** Winsorizes a single hourly observation against the trailing 7-day
 * median: any value above 3x that median is clipped to 3x, so one large
 * payment cannot single-handedly blow up the EWMA/P99 estimate. */
export function winsorize(amountStroops: bigint, trailing7dMedian: bigint): bigint {
  if (trailing7dMedian <= 0n) {
    return amountStroops;
  }
  const cap = trailing7dMedian * 3n;
  return amountStroops > cap ? cap : amountStroops;
}

/** Median of a bigint array. Used to compute the trailing-7d median that
 * winsorize() clips against; callers pass the last 168 hourly buckets
 * (7 days) ending the hour before the observation being winsorized. */
export function median(values: bigint[]): bigint {
  if (values.length === 0) {
    return 0n;
  }
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  return (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** Converts a half-life (in the same period unit as the observation
 * series, here hours) to the EWMA smoothing factor alpha, the standard
 * exponential-decay identity: alpha = 1 - exp(-ln(2) / halfLifePeriods). */
export function halfLifeToAlpha(halfLifePeriods: number): number {
  if (halfLifePeriods <= 0) {
    throw new Error("halfLifePeriods must be positive");
  }
  return 1 - Math.exp(-Math.LN2 / halfLifePeriods);
}

/** One EWMA step. `previous` is null on the very first observation, in
 * which case the EWMA is seeded with that observation directly. */
export function ewmaStep(previous: number | null, observation: number, alpha: number): number {
  if (previous === null) {
    return observation;
  }
  return alpha * observation + (1 - alpha) * previous;
}

/** Runs both the 6h-half-life "fast" and 7d-half-life "slow" EWMAs over
 * an hourly-bucketed, already-winsorized observation series, returning
 * the final value of each in USDC stroops per hour. */
export function computeEwmas(
  winsorizedHourlyStroops: number[],
): { fastPerHour: number; slowPerHour: number } {
  const fastAlpha = halfLifeToAlpha(6); // 6 hours
  const slowAlpha = halfLifeToAlpha(24 * 7); // 7 days, in hours
  let fast: number | null = null;
  let slow: number | null = null;
  for (const obs of winsorizedHourlyStroops) {
    fast = ewmaStep(fast, obs, fastAlpha);
    slow = ewmaStep(slow, obs, slowAlpha);
  }
  return { fastPerHour: fast ?? 0, slowPerHour: slow ?? 0 };
}

export interface Tier0TargetParams {
  fastPerHourStroops: number;
  slowPerHourStroops: number;
  /** Seconds, matching policy-recall's own RecallConfig.window. */
  recallWindowSeconds: number;
  /** Operator-set buffer multiplier over the raw P99 burn-rate estimate. */
  k: number;
  /** USDC-equivalent buffer so a real XLM fee-floor top-up never dips
   * Tier 0 below its own minimum. */
  xlmFeeFloorUsdStroops: bigint;
}

/** target = max(fast, slow) * recall_window * k + xlm_fee_floor_usd */
export function computeTier0Target(params: Tier0TargetParams): bigint {
  const {
    fastPerHourStroops,
    slowPerHourStroops,
    recallWindowSeconds,
    k,
    xlmFeeFloorUsdStroops,
  } = params;
  const perHour = Math.max(fastPerHourStroops, slowPerHourStroops);
  const perSecond = perHour / 3600;
  const raw = perSecond * recallWindowSeconds * k;
  return BigInt(Math.round(raw)) + xlmFeeFloorUsdStroops;
}

export interface HysteresisState {
  /** Unix seconds the computed target first went (and has stayed)
   * strictly below the current on-chain target, or null if it is not
   * currently below (or the on-chain target was just raised). */
  belowSinceSeconds: number | null;
}

export interface HysteresisDecision {
  /** The target to actually propose on-chain this tick, after applying
   * asymmetric hysteresis. Equal to onChainTarget when a decline hasn't
   * been sustained long enough yet. */
  appliedTarget: bigint;
  nextState: HysteresisState;
}

const LOWER_AFTER_SECONDS = 24 * 3600;

/** Raise immediately; lower only after the computed target has stayed
 * continuously below the current on-chain target for 24h. Prevents a
 * single quiet hour from shrinking Tier 0 right before a real burst,
 * without ever delaying a real increase. */
export function applyHysteresis(
  computedTarget: bigint,
  onChainTarget: bigint,
  nowSeconds: number,
  state: HysteresisState,
): HysteresisDecision {
  if (computedTarget >= onChainTarget) {
    return {
      appliedTarget: computedTarget,
      nextState: { belowSinceSeconds: null },
    };
  }

  const belowSince = state.belowSinceSeconds ?? nowSeconds;
  const sustainedSeconds = nowSeconds - belowSince;
  if (sustainedSeconds >= LOWER_AFTER_SECONDS) {
    return {
      appliedTarget: computedTarget,
      nextState: { belowSinceSeconds: null },
    };
  }
  return {
    appliedTarget: onChainTarget,
    nextState: { belowSinceSeconds: belowSince },
  };
}

/** Only worth a real on-chain write once the proposed target diverges
 * from the current on-chain value by more than `bandBps` (relative to
 * the on-chain value), avoiding a transaction for a negligible change. */
export function shouldWriteOnChain(
  proposedTarget: bigint,
  onChainTarget: bigint,
  bandBps: number,
): boolean {
  if (onChainTarget === 0n) {
    return proposedTarget !== 0n;
  }
  const diff = proposedTarget > onChainTarget
    ? proposedTarget - onChainTarget
    : onChainTarget - proposedTarget;
  const bandAbs = (onChainTarget * BigInt(bandBps)) / 10_000n;
  return diff > bandAbs;
}

/** Whether Tier 0 is low enough to trigger a real recall from Tier 1,
 * `refillBandBps` of the (hysteresis-applied) target. */
export function shouldRecall(
  tier0Balance: bigint,
  appliedTarget: bigint,
  refillBandBps: number,
): boolean {
  const threshold = (appliedTarget * BigInt(refillBandBps)) / 10_000n;
  return tier0Balance < threshold;
}
