"use client";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useAnimateOnceOnMount } from "@/hooks/useAnimateOnceOnMount";
import { toRangeSeries, formatChartTimestamp } from "@/lib/chartSeries";
import { formatStroops } from "@/lib/formatAmount";
import type { SlaSnapshot } from "@/lib/telemetry";

const chartConfig = {
  balance: { label: "Tier 0 balance", color: "var(--chart-1)" },
  target: { label: "Tier 0 target", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function Tier0Chart({
  snapshot,
  criticalFloor,
}: {
  snapshot: SlaSnapshot;
  /** Raw stroops string, or null if not loaded yet — the reference line
   * is simply omitted until it is, rather than blocking the rest of the
   * chart on a second, separate fetch. */
  criticalFloor: string | null;
}) {
  const { shouldAnimate, handleAnimationEnd } = useAnimateOnceOnMount();

  if (snapshot.tier0Series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real Tier 0 balance samples in this window yet.
      </p>
    );
  }

  const points = snapshot.tier0Series.map((p) => ({
    timestampSeconds: p.timestampSeconds,
    time: formatChartTimestamp(p.timestampSeconds),
    balance: Number(p.balanceStroops),
    target: Number(p.targetStroops),
  }));
  const data = toRangeSeries(points, "balance", "target");
  const criticalFloorValue = criticalFloor !== null ? Number(criticalFloor) : null;

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          // Recharts auto-scales the domain from the plotted series alone,
          // so a ReferenceLine value above that range (a healthy vault
          // whose critical floor sits well under its real balance/target)
          // would silently render off-screen. Extending the domain to
          // always include the real critical floor keeps the line visible.
          domain={[0, (dataMax: number) => Math.max(dataMax, criticalFloorValue ?? 0) * 1.05]}
          // Unit suffix dropped here (kept in the tooltip, which has
          // room): the axis column is narrow and sits right next to the
          // reference line's own "Critical floor" label.
          tickFormatter={(value: number) => formatStroops(String(Math.round(value)), null, 0)}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <span className="font-mono tabular-nums">
                  {typeof value === "number"
                    ? formatStroops(String(Math.round(value)), "USDC")
                    : String(value)}
                  <span className="ml-1 text-muted-foreground">
                    {name === "balance" ? "Tier 0 balance" : "Tier 0 target"}
                  </span>
                </span>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        {/* Shades the real gap between balance and target at each point
            (toRangeSeries handles either one being larger) — visible
            magnitude of buffer/deficit, not just two lines a viewer has
            to mentally subtract. Excluded from the legend/tooltip: it's
            a derived visual aid, not its own real metric. */}
        <Area
          dataKey="range"
          fill="var(--color-balance)"
          fillOpacity={0.15}
          stroke="none"
          isAnimationActive={shouldAnimate}
          legendType="none"
          tooltipType="none"
        />
        <Line
          dataKey="balance"
          type="monotone"
          stroke="var(--color-balance)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={shouldAnimate}
          onAnimationEnd={handleAnimationEnd}
        />
        <Line
          dataKey="target"
          type="monotone"
          stroke="var(--color-target)"
          strokeWidth={2}
          strokeDasharray="4 4"
          dot={false}
          isAnimationActive={shouldAnimate}
        />
        {criticalFloorValue !== null && (
          <ReferenceLine
            y={criticalFloorValue}
            stroke="var(--destructive)"
            strokeDasharray="4 4"
            label={{
              value: "Critical floor",
              position: "insideTopLeft",
              fill: "var(--destructive)",
              fontSize: 11,
            }}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  );
}
