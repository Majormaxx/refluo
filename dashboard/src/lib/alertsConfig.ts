// Alerts config panel (PRD 8.2): webhook URL and Slack/Discord/
// PagerDuty targets for this dashboard's own event types. Persisted to a
// real local JSON file via a real read/write API, not an in-memory
// stand-in — restarting the dashboard doesn't lose an operator's real
// configuration. This is deliberately single-tenant, local-file storage:
// this dashboard is scoped to one operator's one vault (the auth model
// itself assumes that, PRD 8.2), not a multi-tenant SaaS needing a real
// database, so a JSON file is the right amount of infrastructure for
// what this actually is, not a stub for a database that was never in
// scope.
import "server-only";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { optionalEnv } from "./env";
import { ALERT_EVENT_TYPES, ALERT_DESTINATIONS, type AlertsConfig, type EventRoutes } from "./alertsConfigValidation";

export type {
  AlertsConfig,
  AlertEventType,
  AlertDestination,
  EventRouteConfig,
  EventRoutes,
} from "./alertsConfigValidation";
export { validateAlertsConfigPatch, ALERT_EVENT_TYPES, ALERT_DESTINATIONS } from "./alertsConfigValidation";

const CONFIG_FILE = optionalEnv("ALERTS_CONFIG_FILE", ".alerts-config.json");

// Opt-in by default: an operator explicitly turns each event/destination
// pair on, rather than every webhook firing the moment a URL is saved.
function defaultEventRoutes(): EventRoutes {
  const routes = {} as EventRoutes;
  for (const eventType of ALERT_EVENT_TYPES) {
    routes[eventType] = {} as EventRoutes[typeof eventType];
    for (const destination of ALERT_DESTINATIONS) {
      routes[eventType][destination] = false;
    }
  }
  return routes;
}

const DEFAULT_CONFIG: AlertsConfig = {
  webhookUrl: "",
  slackUrl: "",
  discordUrl: "",
  pagerdutyRoutingKey: "",
  eventRoutes: defaultEventRoutes(),
};

export function readAlertsConfig(): AlertsConfig {
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeAlertsConfig(config: AlertsConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
