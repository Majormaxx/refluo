// Pure validation for an alerts-config PUT body, split out of
// alertsConfig.ts (which touches the filesystem and is real
// "server-only") so this part is unit-testable from a plain Node
// context, the same pure/integration split used throughout this
// workspace (e.g. keeper/src/forecaster.ts vs forecasterLoop.ts).

// The four real event types the SDK's own on(...) spec names (PRD 8.1).
// All four have a real dispatch signal today (adr/0023): pause.triggered
// (HealthMonitor's real Paused event), recall.triggered (the metrics
// log's real recall_triggered event), state.transitioned (risk-engine's
// real StateChanged event), cap.breached (the keeper's own observed
// CapExceeded transaction rejection — a real signal, just not a contract
// event; see adr/0023 for why a durable on-chain event can't exist for a
// hard-reverted call).
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

const URL_FIELDS: Array<keyof AlertsConfig> = ["webhookUrl", "slackUrl", "discordUrl"];

function validateEventRoutes(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "eventRoutes must be a JSON object";
  }
  const record = value as Record<string, unknown>;
  const knownEventTypes = new Set<string>(ALERT_EVENT_TYPES);
  for (const eventType of Object.keys(record)) {
    if (!knownEventTypes.has(eventType)) {
      return `unknown event type in eventRoutes: ${eventType}`;
    }
    const destinations = record[eventType];
    if (typeof destinations !== "object" || destinations === null || Array.isArray(destinations)) {
      return `eventRoutes.${eventType} must be a JSON object`;
    }
    const destinationRecord = destinations as Record<string, unknown>;
    const knownDestinations = new Set<string>(ALERT_DESTINATIONS);
    for (const destination of Object.keys(destinationRecord)) {
      if (!knownDestinations.has(destination)) {
        return `unknown destination in eventRoutes.${eventType}: ${destination}`;
      }
      if (typeof destinationRecord[destination] !== "boolean") {
        return `eventRoutes.${eventType}.${destination} must be a boolean`;
      }
    }
  }
  return null;
}

/** Validates a PUT body before it's ever merged and persisted: every
 * field must be a real string, and every *Url field, if non-empty, must
 * actually parse as an http(s) URL — a malformed value written once here
 * would otherwise silently break whatever real webhook delivery reads
 * this file next. Returns the first problem found, or null if the body
 * is clean. */
export function validateAlertsConfigPatch(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  const record = body as Record<string, unknown>;
  const knownFields = new Set<string>([...URL_FIELDS, "pagerdutyRoutingKey", "eventRoutes"]);
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      return `unknown field: ${key}`;
    }
    if (key === "eventRoutes") {
      continue;
    }
    if (typeof record[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  for (const field of URL_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value === "") {
      continue;
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `${field} must be an http(s) URL`;
      }
    } catch {
      return `${field} is not a valid URL`;
    }
  }
  if ("eventRoutes" in record) {
    const eventRoutesError = validateEventRoutes(record.eventRoutes);
    if (eventRoutesError) {
      return eventRoutesError;
    }
  }
  return null;
}
