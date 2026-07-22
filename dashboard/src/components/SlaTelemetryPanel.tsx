"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { PanelError } from "@/components/PanelError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useApiResource } from "@/hooks/useApiResource";
import type { SlaSnapshot } from "@/lib/telemetry";

interface TelemetryResponse {
  snapshot: SlaSnapshot | null;
  message?: string;
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function formatTimestamp(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const recallLatencyChartConfig = {
  count: { label: "Recalls", color: "var(--chart-1)" },
} satisfies ChartConfig;

const tier0ChartConfig = {
  balance: { label: "Tier 0 balance", color: "var(--chart-1)" },
  target: { label: "Tier 0 target", color: "var(--chart-3)" },
} satisfies ChartConfig;

const forecasterChartConfig = {
  predicted: { label: "Predicted burn/hr", color: "var(--chart-1)" },
  realized: { label: "Realized burn/hr", color: "var(--chart-3)" },
} satisfies ChartConfig;

function RecallLatencyChart({ snapshot }: { snapshot: SlaSnapshot }) {
  if (snapshot.recallLatency.count === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real recall-latency samples in this window yet.
      </p>
    );
  }
  const data = snapshot.recallLatency.buckets.map((b) => ({ label: b.label, count: b.count }));
  return (
    <ChartContainer config={recallLatencyChartConfig} className="aspect-auto h-48 w-full">
      <BarChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}

function Tier0Chart({ snapshot }: { snapshot: SlaSnapshot }) {
  if (snapshot.tier0Series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real Tier 0 balance samples in this window yet.
      </p>
    );
  }
  const data = snapshot.tier0Series.map((p) => ({
    timestampSeconds: p.timestampSeconds,
    time: formatTimestamp(p.timestampSeconds),
    balance: Number(p.balanceStroops),
    target: Number(p.targetStroops),
  }));
  return (
    <ChartContainer config={tier0ChartConfig} className="aspect-auto h-48 w-full">
      <LineChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
        <YAxis tickLine={false} axisLine={false} width={48} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="balance"
          type="monotone"
          stroke="var(--color-balance)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          dataKey="target"
          type="monotone"
          stroke="var(--color-target)"
          strokeWidth={2}
          strokeDasharray="4 4"
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

function ForecasterErrorChart({ snapshot }: { snapshot: SlaSnapshot }) {
  if (snapshot.forecasterErrorSeries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No real Forecaster backtest hours in this window yet.
      </p>
    );
  }
  const data = snapshot.forecasterErrorSeries.map((p) => ({
    timestampSeconds: p.timestampSeconds,
    time: formatTimestamp(p.timestampSeconds),
    predicted: p.predictedStroopsPerHour,
    realized: p.realizedStroopsPerHour,
  }));
  return (
    <ChartContainer config={forecasterChartConfig} className="aspect-auto h-48 w-full">
      <LineChart data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="time" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} />
        <YAxis tickLine={false} axisLine={false} width={48} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line
          dataKey="predicted"
          type="monotone"
          stroke="var(--color-predicted)"
          strokeWidth={2}
          dot={false}
        />
        <Line
          dataKey="realized"
          type="monotone"
          stroke="var(--color-realized)"
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

const TELEMETRY_POLL_MS = 30_000;

export function SlaTelemetryPanel() {
  const { data, error, loading, reload } = useApiResource<TelemetryResponse>("/api/telemetry", {
    pollIntervalMs: TELEMETRY_POLL_MS,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>SLA telemetry</CardTitle>
        {data?.snapshot && (
          <CardDescription>
            Window: last{" "}
            {Math.round(
              (data.snapshot.windowEndSeconds - data.snapshot.windowStartSeconds) / 3600,
            )}
            h, generated {new Date(data.snapshot.generatedAtSeconds * 1000).toLocaleString()}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={2} />}
        {data && data.snapshot === null && (
          <p className="text-sm text-muted-foreground">
            The reporter loop (<code>keeper/src/reporterLoop.ts</code>) hasn&apos;t produced a
            snapshot yet. Run <code>npm run reporter:once</code> in <code>keeper/</code> against
            this vault.
          </p>
        )}
        {data?.snapshot && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
              <Stat value={`${(data.snapshot.tier0HitRate * 100).toFixed(1)}%`} label="Tier 0 hit rate" />
              <Stat value={String(data.snapshot.pauseStats.pauseCount)} label="Pause count" />
              <Stat
                value={`${data.snapshot.pauseStats.totalPauseDurationSeconds}s`}
                label="Total pause duration"
              />
              <Stat
                value={`${data.snapshot.recallLatency.p50Seconds}s / ${data.snapshot.recallLatency.p99Seconds}s`}
                label={`Recall latency p50 / p99 (${data.snapshot.recallLatency.count} samples)`}
              />
              <Stat
                value={`${data.snapshot.forecasterError.meanAbsPercentError.toFixed(1)}%`}
                label={`Forecaster mean abs % error (${data.snapshot.forecasterError.count} hours)`}
              />
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-medium">Recall latency distribution</h3>
                <RecallLatencyChart snapshot={data.snapshot} />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-medium">Tier 0 balance vs. target</h3>
                <Tier0Chart snapshot={data.snapshot} />
              </div>
              <div className="md:col-span-2">
                <h3 className="mb-2 text-sm font-medium">
                  Forecaster: predicted vs. realized burn rate
                </h3>
                <ForecasterErrorChart snapshot={data.snapshot} />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
