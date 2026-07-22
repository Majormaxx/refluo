"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldAlert, PlayCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PanelError } from "@/components/PanelError";
import { PanelSkeleton } from "@/components/PanelSkeleton";
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { pauseAsGuardian, resumeEarlyAsAdmin } from "@/lib/actions/healthMonitorActions";
import { describeActionError } from "@/lib/actions/actionError";
import type { GuardianPanelData } from "@/lib/contracts/healthMonitor";

const PAUSE_STATUS_POLL_MS = 15_000;

export function GuardianPanel() {
  const { authenticated, role, address } = useAuth();
  const { data, error, loading, reload } = useApiResource<GuardianPanelData>(
    "/api/health-monitor/status",
    { pollIntervalMs: PAUSE_STATUS_POLL_MS },
  );
  const [busy, setBusy] = useState(false);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  async function handlePause() {
    if (!address) return;
    setBusy(true);
    try {
      const status = await pauseAsGuardian(address);
      toast.success("Pause submitted", { description: `Transaction status: ${status}` });
      reload();
    } catch (err) {
      const { title, description } = describeActionError(err);
      toast.error(title, { description });
    } finally {
      setBusy(false);
    }
  }

  async function handleResume() {
    if (!address) return;
    setBusy(true);
    try {
      const status = await resumeEarlyAsAdmin(address);
      toast.success("Resume submitted", { description: `Transaction status: ${status}` });
      reload();
    } catch (err) {
      const { title, description } = describeActionError(err);
      toast.error(title, { description });
    } finally {
      setBusy(false);
    }
  }

  const countdown =
    data?.pauseExpirySeconds && nowSeconds !== null
      ? Math.max(0, data.pauseExpirySeconds - nowSeconds)
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Guardian / pause</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={3} />}
        {data && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Status</span>
              <Badge variant={data.paused ? "destructive" : "secondary"}>
                {data.paused ? "PAUSED" : "not paused"}
              </Badge>
            </div>
            {data.paused && countdown !== null && (
              <p className="text-sm text-muted-foreground">
                Auto-expires in {Math.floor(countdown / 3600)}h {Math.floor((countdown % 3600) / 60)}m
              </p>
            )}
            {data.paused && countdown === null && (
              <p className="text-sm text-muted-foreground">
                Auto-expiry countdown unavailable: the public RPC&apos;s event retention window
                doesn&apos;t reach far enough back to find the triggering event right now (see
                adr/0021). The underlying pause state itself is still accurate above.
              </p>
            )}

            <div>
              <h3 className="mb-2 text-sm font-medium">Guardians ({data.guardians.length})</h3>
              <ul className="space-y-1">
                {data.guardians.map((g) => (
                  <li key={g} className="font-mono text-xs">
                    {g.slice(0, 6)}…{g.slice(-6)}
                  </li>
                ))}
              </ul>
            </div>

            {authenticated && role === "guardian" && !data.paused && (
              <Button onClick={handlePause} disabled={busy} variant="destructive">
                <ShieldAlert className="size-4" />
                {busy ? "Signing…" : "Pause (guardian)"}
              </Button>
            )}
            {authenticated && role === "admin" && data.paused && (
              <Button onClick={handleResume} disabled={busy}>
                <PlayCircle className="size-4" />
                {busy ? "Signing…" : "Resume early (admin)"}
              </Button>
            )}

            <p className="text-xs text-muted-foreground">
              Extension request flow: <code>HealthMonitor.extend()</code> is not built on-chain
              yet (contracts/health-monitor/src/lib.rs&apos;s own doc comment), so this UI has no
              real call to wire it to — not shown here rather than faked.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
