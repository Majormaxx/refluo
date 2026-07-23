"use client";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
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
import type { SlaSnapshot } from "@/lib/telemetry";

const chartConfig = {
  predicted: { label: "Predicted burn/hr", color: "var(--chart-1)" },
  realized: { label: "Realized burn/hr", color: "var(--chart-3)" },
} satisfies ChartConfig;

export function ForecasterErrorChart({ snapshot }: { snapshot: SlaSnapshot }) {
  const { shouldAnimate, handleAnimationEnd } = useAnimateOnceOnMount();

  if (snapshot.forecasterErrorSeries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real Forecaster backtest hours in this window yet.
      </p>
    );
  }

  const points = snapshot.forecasterErrorSeries.map((p) => ({
    timestampSeconds: p.timestampSeconds,
    time: formatChartTimestamp(p.timestampSeconds),
    predicted: p.predictedStroopsPerHour,
    realized: p.realizedStroopsPerHour,
  }));
  const data = toRangeSeries(points, "predicted", "realized");

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
      <ComposedChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
        <YAxis tickLine={false} axisLine={false} width={48} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {/* Shades the real gap between predicted and realized burn rate —
            forecast error visible at a glance instead of a mental
            subtraction between two curves. Excluded from legend/tooltip:
            a derived visual aid, not its own real metric. */}
        <Area
          dataKey="range"
          fill="var(--chart-4)"
          fillOpacity={0.2}
          stroke="none"
          isAnimationActive={shouldAnimate}
          legendType="none"
          tooltipType="none"
        />
        <Line
          dataKey="predicted"
          type="monotone"
          stroke="var(--color-predicted)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={shouldAnimate}
          onAnimationEnd={handleAnimationEnd}
        />
        <Line
          dataKey="realized"
          type="monotone"
          stroke="var(--color-realized)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={shouldAnimate}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
