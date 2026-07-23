// Humanizes raw base-unit ("stroop") amounts for display. Both native
// XLM and Circle's USDC SAC wrapper use Stellar's standard 7-decimal
// precision (a real protocol constant: 1 XLM = 1 USDC-SAC-unit =
// 10_000_000 stroops), so the same divisor is correct for both — the
// existing UI calling USDC amounts "stroops" too is itself an existing
// mislabeling this fixes: "stroop" is technically an XLM-specific term,
// so every call site now names the real asset instead.
const STROOPS_PER_UNIT = 10_000_000;

export type AssetUnit = "USDC" | "XLM";

/** Display-only: converts through `Number`, so precision beyond
 * `Number.MAX_SAFE_INTEGER` stroops (about 900 million real units) isn't
 * guaranteed. Never used for accounting/authorization — only for
 * rendering a human-readable amount — and far outside this system's real
 * operating scale (current Tier 0 bounds are tens of billions of
 * stroops, i.e. tens of thousands of real units). */
export function formatStroops(
  raw: string | bigint,
  /** `null` omits the unit suffix — for a space-constrained label (a
   * narrow chart axis) where the surrounding context (chart title,
   * tooltip) already says which asset this is. */
  unit: AssetUnit | null,
  maximumFractionDigits = 2,
): string {
  const value = Number(BigInt(raw)) / STROOPS_PER_UNIT;
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
  return unit === null ? formatted : `${formatted} ${unit}`;
}
