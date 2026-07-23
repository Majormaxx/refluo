"use client";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useAnimateOnceOnMount } from "@/hooks/useAnimateOnceOnMount";
import type { SlaSnapshot } from "@/lib/telemetry";

const chartConfig = {
  count: { label: "Recalls", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function RecallLatencyChart({ snapshot }: { snapshot: SlaSnapshot }) {
  const { shouldAnimate, handleAnimationEnd } = useAnimateOnceOnMount();

  if (snapshot.recallLatency.count === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real recall-latency samples in this window yet.
      </p>
    );
  }

  const data = snapshot.recallLatency.buckets.map((b) => ({ label: b.label, count: b.count }));

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-48 w-full">
      <BarChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar
          dataKey="count"
          fill="var(--color-count)"
          radius={4}
          isAnimationActive={shouldAnimate}
          onAnimationEnd={handleAnimationEnd}
        />
      </BarChart>
    </ChartContainer>
  );
}
