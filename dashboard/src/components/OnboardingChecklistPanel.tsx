"use client";
import { CircleCheck, CircleX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PanelError } from "@/components/PanelError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { evaluateGoLiveChecklist } from "@/lib/onboardingChecklist";
import type { VaultOverview } from "@/lib/contracts/vaultOverview";
import type { GuardianPanelData } from "@/lib/contracts/healthMonitor";
import type { SlaSnapshot } from "@/lib/telemetry";

/** PRD §9 step 7: "Go-live checklist (surfaced in dashboard before
 * 'activate')" — every condition it names, evaluated from real data the
 * other panels on this page already fetch (see lib/onboardingChecklist.ts
 * for the pure evaluation, unit-tested independently of this component). */
export function OnboardingChecklistPanel() {
  const { role, loading: authLoading } = useAuth();
  const isAdmin = role === "admin";

  const vaultOverview = useApiResource<VaultOverview>(isAdmin ? "/api/vault/overview" : null);
  const guardianData = useApiResource<GuardianPanelData>(isAdmin ? "/api/health-monitor/status" : null);
  const telemetry = useApiResource<{ snapshot: SlaSnapshot | null }>(isAdmin ? "/api/telemetry" : null);

  if (authLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Go-live checklist</CardTitle>
        </CardHeader>
        <CardContent>
          <PanelSkeleton rows={1} />
        </CardContent>
      </Card>
    );
  }

  if (!isAdmin) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Go-live checklist</CardTitle>
          <CardDescription>Sign in as an admin to view readiness for this vault.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const error = vaultOverview.error ?? guardianData.error ?? telemetry.error;
  const loading = vaultOverview.loading || guardianData.loading || telemetry.loading;
  const reload = () => {
    vaultOverview.reload();
    guardianData.reload();
    telemetry.reload();
  };

  const items =
    vaultOverview.data && guardianData.data && telemetry.data !== null
      ? evaluateGoLiveChecklist({
          vaultOverview: vaultOverview.data,
          guardianData: guardianData.data,
          slaSnapshot: telemetry.data.snapshot,
        })
      : null;

  const allPassed = items?.every((i) => i.passed) ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Go-live checklist</CardTitle>
        <CardDescription>
          {items ? (allPassed ? "Ready to activate." : "Not ready yet — see below.") : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={5} />}
        {items && (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.key} className="flex items-start gap-2 text-sm">
                {item.passed ? (
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <CircleX className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
                )}
                <div>
                  <p className="font-medium">{item.label}</p>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
