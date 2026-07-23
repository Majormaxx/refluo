"use client";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { PanelError } from "@/components/PanelError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useApiResource } from "@/hooks/useApiResource";
import type { PauseEpisode, PauseResolution } from "@/lib/contracts/pauseHistory";

const RESOLUTION_LABEL: Record<PauseResolution, string> = {
  active: "still active",
  resumed_early: "resumed early",
  auto_expired: "auto-expired",
  superseded: "superseded by re-trigger",
};

function resolutionBadgeVariant(resolution: PauseResolution) {
  if (resolution === "active") return "destructive" as const;
  if (resolution === "resumed_early") return "secondary" as const;
  return "outline" as const;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function PauseHistoryPanel() {
  const { data, error, loading, reload } = useApiResource<{ episodes: PauseEpisode[] }>(
    "/api/health-monitor/pause-history",
  );
  // Lazy initializer, not a direct Date.now() call in the render body —
  // this is a snapshot for a still-active episode's running duration, not
  // a live countdown, so it doesn't need to re-tick every second.
  const [nowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Incident history</CardTitle>
        <CardDescription>
          Every past pause episode, reconstructed from HealthMonitor&apos;s own real on-chain
          events. Anyone can view this (watcher transparency) — no sign-in required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={3} />}
        {data && data.episodes.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No pause episodes found within the event-retention lookback window.
          </p>
        )}
        {data && data.episodes.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>paused at</TableHead>
                  <TableHead>trigger</TableHead>
                  <TableHead>resolution</TableHead>
                  <TableHead>duration</TableHead>
                  <TableHead>extensions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.episodes.map((episode) => {
                  const durationSeconds =
                    (episode.resolvedAtSeconds ?? nowSeconds) - episode.pausedAtSeconds;
                  return (
                    <TableRow key={episode.pausedAtSeconds}>
                      <TableCell>{new Date(episode.pausedAtSeconds * 1000).toLocaleString()}</TableCell>
                      <TableCell className="font-mono text-xs">{episode.trigger}</TableCell>
                      <TableCell>
                        <Badge variant={resolutionBadgeVariant(episode.resolution)}>
                          {RESOLUTION_LABEL[episode.resolution]}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDuration(durationSeconds)}</TableCell>
                      <TableCell>{episode.extensions.length}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
