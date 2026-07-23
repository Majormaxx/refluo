"use client";
import { useEffect } from "react";
import { PauseCircle, TriangleAlert } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { SystemStateBadge } from "@/components/SystemStateBadge";
import { FreshnessIndicator } from "@/components/FreshnessIndicator";
import type { VaultStatus } from "@/lib/contracts/vaultOverview";
import type { GuardianPanelData } from "@/lib/contracts/healthMonitor";
import type { SlaSnapshot } from "@/lib/telemetry";

// Live monitoring surfaces poll; this is the fastest one, deliberately —
// it's the "is anything on fire right now" answer, the whole reason it
// exists separate from the panels below.
const STATUS_POLL_MS = 15_000;

export function StatusBar() {
  const { authenticated } = useAuth();
  // Each call's own pollIntervalMs is deliberately left unset: three
  // independent timers would drift apart over time into three
  // uncoordinated requests against a public RPC the ADRs already
  // document as flaky. One shared interval below drives all three
  // reload()s together instead.
  const {
    data: status,
    lastSuccessAtMs,
    reload: reloadStatus,
  } = useApiResource<VaultStatus>(authenticated ? "/api/vault/status" : null);
  const { data: guardianData, reload: reloadGuardian } = useApiResource<GuardianPanelData>(
    authenticated ? "/api/health-monitor/status" : null,
  );
  const { data: telemetry, reload: reloadTelemetry } = useApiResource<{
    snapshot: SlaSnapshot | null;
  }>(authenticated ? "/api/telemetry" : null);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    const interval = setInterval(() => {
      reloadStatus();
      reloadGuardian();
      reloadTelemetry();
    }, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [authenticated, reloadStatus, reloadGuardian, reloadTelemetry]);

  if (!authenticated || !status) {
    return null;
  }

  const hitRate = telemetry?.snapshot ? `${(telemetry.snapshot.tier0HitRate * 100).toFixed(1)}%` : null;
  // The one disagreement derivable from data already on screen:
  // check_and_trip() (contracts/risk-engine/src/lib.rs:290-307) is the
  // only thing that folds a real HealthMonitor pause into RiskEngine's
  // own cached SystemState, and it's a permissionless crank, not an
  // automatic sync — so a real, live guardian pause can sit for a while
  // before RiskEngine's state reflects it. Surfaced explicitly rather
  // than left for an operator to notice the two badges disagree.
  const riskStateLagsRealPause = !!guardianData?.paused && status.systemState !== "Paused";

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-card px-4 py-3 text-sm">
      <SystemStateBadge state={status.systemState} />
      {guardianData?.paused && (
        <span className="flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 font-medium text-red-800 dark:bg-red-950 dark:text-red-300">
          <PauseCircle className="size-3.5" />
          Guardian pause active
        </span>
      )}
      {riskStateLagsRealPause && (
        <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <TriangleAlert className="size-3.5" />
          Guardian pause is live; risk engine state hasn&apos;t re-synced yet
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
      <FreshnessIndicator lastSuccessAtMs={lastSuccessAtMs} />
    </div>
  );
}
