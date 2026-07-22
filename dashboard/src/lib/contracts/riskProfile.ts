// Derives the operator-facing risk-profile label from real on-chain
// TierConfig thresholds. RiskEngine's `init_with_profile` only ever
// persists the resolved bps numbers (contracts/risk-engine/src/lib.rs:
// 95-128), never a stored "Conservative"/"Balanced"/"Aggressive" label,
// so there is no getter for the label itself. This matches the two
// stored fields against the three real presets instead of inventing a
// separate label field on-chain; anything that doesn't match exactly is
// a genuine custom config an admin set within their own bounds (PRD
// §9 step 2), not an error.
export type RiskProfileLabel = "Conservative" | "Balanced" | "Aggressive" | "Custom";

export interface RiskProfileThresholds {
  preemptiveUtilBps: number;
  fullDrainUtilBps: number;
}

const PRESETS: Record<Exclude<RiskProfileLabel, "Custom">, RiskProfileThresholds> = {
  Conservative: { preemptiveUtilBps: 7500, fullDrainUtilBps: 8500 },
  Balanced: { preemptiveUtilBps: 8500, fullDrainUtilBps: 9200 },
  Aggressive: { preemptiveUtilBps: 9000, fullDrainUtilBps: 9700 },
};

export function deriveRiskProfileLabel(thresholds: RiskProfileThresholds): RiskProfileLabel {
  for (const [label, preset] of Object.entries(PRESETS) as Array<
    [Exclude<RiskProfileLabel, "Custom">, RiskProfileThresholds]
  >) {
    if (
      preset.preemptiveUtilBps === thresholds.preemptiveUtilBps &&
      preset.fullDrainUtilBps === thresholds.fullDrainUtilBps
    ) {
      return label;
    }
  }
  return "Custom";
}
