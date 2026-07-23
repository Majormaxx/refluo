// Real alert dispatch for the 4 event types the SDK's own on(...) spec
// names (PRD §8.1), closing the gap found while auditing the dashboard
// against the PRD: alerts config existed (dashboard/src/lib/alertsConfig.ts)
// but nothing ever read it and actually POSTed anywhere. Pure payload
// building here (unit-testable, no network); the real HTTP call is the
// one intentionally impure piece, isolated behind an injectable fetch so
// it stays testable too (mirrors reflectorSubscription.ts's own real
// fetch() call, no special mocking framework needed).
//
// Real signal per event type (adr/0023): pause.triggered is
// HealthMonitor's real Paused event, recall.triggered is the metrics
// log's real recall_triggered entry, state.transitioned is risk-engine's
// real StateChanged event — all three have a real poller in
// alertDispatcherLoop.ts. cap.breached is different: risk-engine's
// record_tier1_position() now enforces the cap for real (adr/0023), but a
// hard-reverted call leaves no durable on-chain event to poll for —
// Soroban discards storage writes and published events alike from a
// panicking invocation, the same way an EVM revert drops its logs. The
// real signal is the caller's own rejected transaction result, observed
// inline at the call site, not polled. dispatchAlert below is the one
// function every real call site (the poller, or a future deploy-attempt
// module observing a real CapExceeded rejection) calls into.
export const ALERT_EVENT_TYPES = [
  "pause.triggered",
  "recall.triggered",
  "state.transitioned",
  "cap.breached",
] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export const ALERT_DESTINATIONS = ["webhook", "slack", "discord", "pagerduty"] as const;
export type AlertDestination = (typeof ALERT_DESTINATIONS)[number];

export type EventRouteConfig = Record<AlertDestination, boolean>;
export type EventRoutes = Record<AlertEventType, EventRouteConfig>;

export interface AlertsConfig {
  webhookUrl: string;
  slackUrl: string;
  discordUrl: string;
  pagerdutyRoutingKey: string;
  eventRoutes: EventRoutes;
}

export interface AlertEvent {
  type: AlertEventType;
  atSeconds: number;
  summary: string;
  detail: Record<string, unknown>;
}

export function buildWebhookPayload(event: AlertEvent): object {
  return {
    type: event.type,
    atSeconds: event.atSeconds,
    summary: event.summary,
    detail: event.detail,
  };
}

/** Slack's real incoming-webhook body shape: a top-level `text` field,
 * confirmed from Slack's own API docs (api.slack.com/messaging/webhooks). */
export function buildSlackPayload(event: AlertEvent): object {
  return { text: `*${event.type}*: ${event.summary}` };
}

/** Discord's real webhook body shape: a top-level `content` field,
 * confirmed from Discord's own developer docs (discord.com/developers/docs/resources/webhook). */
export function buildDiscordPayload(event: AlertEvent): object {
  return { content: `**${event.type}**: ${event.summary}` };
}

/** PagerDuty Events API v2's real trigger-event shape, confirmed from
 * PagerDuty's own docs (developer.pagerduty.com/api-reference, Events API
 * v2): routing_key + event_action + a payload object with
 * summary/source/severity/timestamp required, custom_details optional. */
export function buildPagerDutyPayload(event: AlertEvent, routingKey: string): object {
  return {
    routing_key: routingKey,
    event_action: "trigger",
    payload: {
      summary: event.summary,
      source: "refluo-keeper",
      severity: "warning",
      timestamp: new Date(event.atSeconds * 1000).toISOString(),
      custom_details: event.detail,
    },
  };
}

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";

export interface DispatchResult {
  destination: AlertDestination;
  ok: boolean;
  error?: string;
}

type FetchLike = typeof fetch;

/** Real dispatch: for each destination this event's real route config has
 * enabled (and that has a real URL/key configured), POSTs the real
 * destination-specific payload. Never throws — a failed destination is
 * recorded in the returned result, one destination's failure never blocks
 * the others. */
export async function dispatchAlert(
  event: AlertEvent,
  config: AlertsConfig,
  fetchImpl: FetchLike = fetch,
): Promise<DispatchResult[]> {
  const routes = config.eventRoutes[event.type];
  const attempts: Array<{ destination: AlertDestination; url: string; body: object }> = [];

  if (routes?.webhook && config.webhookUrl) {
    attempts.push({ destination: "webhook", url: config.webhookUrl, body: buildWebhookPayload(event) });
  }
  if (routes?.slack && config.slackUrl) {
    attempts.push({ destination: "slack", url: config.slackUrl, body: buildSlackPayload(event) });
  }
  if (routes?.discord && config.discordUrl) {
    attempts.push({ destination: "discord", url: config.discordUrl, body: buildDiscordPayload(event) });
  }
  if (routes?.pagerduty && config.pagerdutyRoutingKey) {
    attempts.push({
      destination: "pagerduty",
      url: PAGERDUTY_EVENTS_URL,
      body: buildPagerDutyPayload(event, config.pagerdutyRoutingKey),
    });
  }

  const results: DispatchResult[] = [];
  for (const attempt of attempts) {
    try {
      const response = await fetchImpl(attempt.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
      });
      results.push({
        destination: attempt.destination,
        ok: response.ok,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      });
    } catch (err) {
      results.push({ destination: attempt.destination, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
