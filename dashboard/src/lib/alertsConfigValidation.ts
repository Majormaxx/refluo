// Pure validation for an alerts-config PUT body, split out of
// alertsConfig.ts (which touches the filesystem and is real
// "server-only") so this part is unit-testable from a plain Node
// context, the same pure/integration split used throughout this
// workspace (e.g. keeper/src/forecaster.ts vs forecasterLoop.ts).
export interface AlertsConfig {
  webhookUrl: string;
  slackUrl: string;
  discordUrl: string;
  pagerdutyRoutingKey: string;
}

const URL_FIELDS: Array<keyof AlertsConfig> = ["webhookUrl", "slackUrl", "discordUrl"];

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
  const knownFields = new Set<string>([...URL_FIELDS, "pagerdutyRoutingKey"]);
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      return `unknown field: ${key}`;
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
  return null;
}
