"use client";
import { cn } from "@/lib/utils";
import { PauseCircle } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { SYSTEM_STATE_STYLE } from "@/lib/systemStateStyle";
import type { VaultStatus } from "@/lib/contracts/vaultOverview";
import type { GuardianPanelData } from "@/lib/contracts/healthMonitor";
import type { SlaSnapshot } from "@/lib/telemetry";

// Live monitoring surfaces poll; this is the fastest one, deliberately —
// it's the "is anything on fire right now" answer, the whole reason it
// exists separate from the panels below.
const STATUS_POLL_MS = 15_000;

export function StatusBar() {
  const { authenticated } = useAuth();
  const { data: status } = useApiResource<VaultStatus>(
    authenticated ? "/api/vault/status" : null,
    { pollIntervalMs: STATUS_POLL_MS },
  );
  const { data: guardianData } = useApiResource<GuardianPanelData>(
    authenticated ? "/api/health-monitor/status" : null,
    { pollIntervalMs: STATUS_POLL_MS },
  );
  const { data: telemetry } = useApiResource<{ snapshot: SlaSnapshot | null }>(
    authenticated ? "/api/telemetry" : null,
    { pollIntervalMs: STATUS_POLL_MS },
  );

  if (!authenticated || !status) {
    return null;
  }

  const state = SYSTEM_STATE_STYLE[status.systemState];
  const StateIcon = state.icon;
  const hitRate = telemetry?.snapshot ? `${(telemetry.snapshot.tier0HitRate * 100).toFixed(1)}%` : null;

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3 text-sm">
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium",
          state.badgeClassName,
        )}
      >
        <StateIcon className="size-3.5" />
        {state.label}
      </span>
      {guardianData?.paused && (
        <span className="flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
          <PauseCircle className="size-3.5" />
          Guardian pause active
        </span>
      )}
      <code className="text-xs text-muted-foreground">
        {status.vaultAddress.slice(0, 6)}…{status.vaultAddress.slice(-6)}
      </code>
      {hitRate && (
        <span className="text-muted-foreground">
          Tier 0 hit rate <span className="font-medium text-foreground">{hitRate}</span>
        </span>
      )}
    </div>
  );
}
