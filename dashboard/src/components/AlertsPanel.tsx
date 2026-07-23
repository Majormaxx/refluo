"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useAuth } from "@/hooks/useAuth";
import { useApiResource } from "@/hooks/useApiResource";
import { fetchJson, ApiClientError } from "@/lib/apiClient";
import { ALERT_EVENT_TYPES, ALERT_DESTINATIONS, type AlertsConfig } from "@/lib/alertsConfigValidation";

const FIELDS: Array<{ key: Exclude<keyof AlertsConfig, "eventRoutes">; label: string }> = [
  { key: "webhookUrl", label: "Webhook URL" },
  { key: "slackUrl", label: "Slack webhook URL" },
  { key: "discordUrl", label: "Discord webhook URL" },
  { key: "pagerdutyRoutingKey", label: "PagerDuty routing key" },
];

const DESTINATION_LABEL: Record<(typeof ALERT_DESTINATIONS)[number], string> = {
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  pagerduty: "PagerDuty",
};

export function AlertsPanel() {
  const { role, loading: authLoading } = useAuth();
  const { data, error, loading, reload } = useApiResource<AlertsConfig>(
    role === "admin" ? "/api/alerts" : null,
  );
  const [draft, setDraft] = useState<AlertsConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const config = draft ?? data;

  if (authLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Alerts config</CardTitle>
        </CardHeader>
        <CardContent>
          <PanelSkeleton rows={1} />
        </CardContent>
      </Card>
    );
  }

  if (role !== "admin") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Alerts config</CardTitle>
          <CardDescription>Sign in as an admin to view or edit alert routing.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      const updated = await fetchJson<AlertsConfig>("/api/alerts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(config),
      });
      setDraft(updated);
      toast.success("Alerts config saved");
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : (err as Error).message;
      toast.error("Save failed", { description: message });
    } finally {
      setSaving(false);
    }
  }

  function toggleRoute(eventType: (typeof ALERT_EVENT_TYPES)[number], destination: (typeof ALERT_DESTINATIONS)[number]) {
    if (!config) return;
    setDraft({
      ...config,
      eventRoutes: {
        ...config.eventRoutes,
        [eventType]: {
          ...config.eventRoutes[eventType],
          [destination]: !config.eventRoutes[eventType][destination],
        },
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts config</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <PanelError error={error} onRetry={reload} />}
        {loading && <PanelSkeleton rows={4} />}
        {config && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {FIELDS.map(({ key, label }) => (
                <div key={key} className="flex flex-col gap-1.5">
                  <Label htmlFor={key}>{label}</Label>
                  <Input
                    id={key}
                    value={config[key]}
                    onChange={(e) => setDraft({ ...config, [key]: e.target.value })}
                  />
                </div>
              ))}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium">Event routing</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Choose which destinations get notified for each real event type. Nothing fires
                until a route is checked here, even if a URL above is filled in.
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>event</TableHead>
                      {ALERT_DESTINATIONS.map((destination) => (
                        <TableHead key={destination} className="text-center">
                          {DESTINATION_LABEL[destination]}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ALERT_EVENT_TYPES.map((eventType) => (
                      <TableRow key={eventType}>
                        <TableCell className="font-mono text-xs">{eventType}</TableCell>
                        {ALERT_DESTINATIONS.map((destination) => (
                          <TableCell key={destination} className="text-center">
                            <Checkbox
                              checked={config.eventRoutes[eventType][destination]}
                              onCheckedChange={() => toggleRoute(eventType, destination)}
                              aria-label={`${eventType} to ${destination}`}
                            />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <Button onClick={save} disabled={saving}>
              <Save className="size-4" />
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
