"use client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { PanelError } from "@/components/PanelError";
import { ChartSkeleton } from "@/components/ChartSkeleton";
import { FreshnessIndicator } from "@/components/FreshnessIndicator";
import { RecallLatencyChart } from "@/components/charts/RecallLatencyChart";
import { Tier0Chart } from "@/components/charts/Tier0Chart";
import { ForecasterErrorChart } from "@/components/charts/ForecasterErrorChart";
import { useApiResource } from "@/hooks/useApiResource";
import type { SlaSnapshot } from "@/lib/telemetry";
import type { VaultStatus } from "@/lib/contracts/vaultOverview";

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

function StatWithTooltip({
  value,
  label,
  tooltip,
}: {
  value: string;
  label: string;
  tooltip: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<div />} className="flex flex-col gap-0.5 text-left">
        <span className="text-xl font-semibold">{value}</span>
        <span className="text-xs text-muted-foreground underline decoration-dotted">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

const TELEMETRY_POLL_MS = 30_000;

export function SlaTelemetryPanel() {
  const { data, error, loading, reload, lastSuccessAtMs } = useApiResource<TelemetryResponse>(
    "/api/telemetry",
    { pollIntervalMs: TELEMETRY_POLL_MS },
  );
  // The critical floor rarely changes, so this is fetched once, without
  // polling, purely to draw the Tier0Chart's reference line — no need to
  // duplicate the expensive /api/vault/overview call for one field.
  const { data: vaultStatus } = useApiResource<VaultStatus>("/api/vault/status");

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>SLA telemetry</CardTitle>
          <FreshnessIndicator lastSuccessAtMs={lastSuccessAtMs} />
        </div>
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
        {loading && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="h-6 w-16 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <ChartSkeleton />
              <ChartSkeleton />
            </div>
            <ChartSkeleton />
          </div>
        )}
        {data && data.snapshot === null && (
          <p className="text-sm text-muted-foreground">
            The reporter loop (<code>keeper/src/reporterLoop.ts</code>) hasn&apos;t produced a
            snapshot yet. Run <code>npm run reporter:once</code> in <code>keeper/</code> against
            this vault.
          </p>
        )}
        {data?.snapshot && (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
              <Stat value={`${(data.snapshot.tier0HitRate * 100).toFixed(1)}%`} label="Tier 0 hit rate" />
              <StatWithTooltip
                value={`${(data.snapshot.agentUptime * 100).toFixed(1)}%`}
                label="Agent uptime"
                tooltip="Measures ticks at/above the critical floor; does not yet distinguish manual top-ups from automated recalls."
              />
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
                <Tier0Chart
                  snapshot={data.snapshot}
                  criticalFloor={vaultStatus?.criticalFloor ?? null}
                />
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
