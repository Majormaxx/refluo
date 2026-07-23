// Shared helper for the two SLA charts that shade the gap between two
// series (Tier0Chart: balance vs. target; ForecasterErrorChart: predicted
// vs. realized). Recharts' own supported form for a shaded band is an
// Area whose dataKey resolves to a [min, max] tuple per point
// (`<Area dataKey="range">`) — this computes that tuple once, regardless
// of which series happens to be larger at a given point (a real balance
// can sit above or below its target at different times).
export function formatChartTimestamp(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toRangeSeries<T extends Record<string, unknown>>(
  points: T[],
  lowKey: keyof T,
  highKey: keyof T,
): Array<T & { range: [number, number] }> {
  return points.map((point) => {
    const low = Number(point[lowKey]);
    const high = Number(point[highKey]);
    return {
      ...point,
      range: [Math.min(low, high), Math.max(low, high)] as [number, number],
    };
  });
}
