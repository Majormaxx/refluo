"use client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

export function SlaTelemetryPanel() {
  const { data, error, loading, reload } = useApiResource<TelemetryResponse>("/api/telemetry");

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
      <CardContent className="space-y-4">
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
        )}
      </CardContent>
    </Card>
  );
}
