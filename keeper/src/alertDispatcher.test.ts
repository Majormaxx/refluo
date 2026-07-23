import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWebhookPayload,
  buildSlackPayload,
  buildDiscordPayload,
  buildPagerDutyPayload,
  dispatchAlert,
  type AlertEvent,
  type AlertsConfig,
} from "./alertDispatcher.js";

function sampleEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    type: "pause.triggered",
    atSeconds: 1_700_000_000,
    summary: "Guardian pause triggered",
    detail: { trigger: "Guardian" },
    ...overrides,
  };
}

function noRoutes(): AlertsConfig["eventRoutes"] {
  const off = { webhook: false, slack: false, discord: false, pagerduty: false };
  return {
    "pause.triggered": { ...off },
    "recall.triggered": { ...off },
    "state.transitioned": { ...off },
    "cap.breached": { ...off },
  };
}

function baseConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    webhookUrl: "https://example.com/webhook",
    slackUrl: "https://hooks.slack.com/services/x",
    discordUrl: "https://discord.com/api/webhooks/x",
    pagerdutyRoutingKey: "real-routing-key",
    eventRoutes: noRoutes(),
    ...overrides,
  };
}

test("buildWebhookPayload carries the real event type, summary, and detail", () => {
  const payload = buildWebhookPayload(sampleEvent()) as Record<string, unknown>;
  assert.equal(payload.type, "pause.triggered");
  assert.equal(payload.summary, "Guardian pause triggered");
  assert.deepEqual(payload.detail, { trigger: "Guardian" });
});

test("buildSlackPayload uses Slack's real top-level text field", () => {
  const payload = buildSlackPayload(sampleEvent()) as Record<string, unknown>;
  assert.match(payload.text as string, /pause\.triggered/);
});

test("buildDiscordPayload uses Discord's real top-level content field", () => {
  const payload = buildDiscordPayload(sampleEvent()) as Record<string, unknown>;
  assert.match(payload.content as string, /pause\.triggered/);
});

test("buildPagerDutyPayload uses the real Events API v2 trigger shape", () => {
  const payload = buildPagerDutyPayload(sampleEvent(), "real-key") as {
    routing_key: string;
    event_action: string;
    payload: { summary: string; source: string; severity: string };
  };
  assert.equal(payload.routing_key, "real-key");
  assert.equal(payload.event_action, "trigger");
  assert.equal(payload.payload.summary, "Guardian pause triggered");
  assert.equal(payload.payload.source, "refluo-keeper");
});

test("dispatchAlert sends nothing when every route is disabled", async () => {
  let callCount = 0;
  const fakeFetch = (async () => {
    callCount++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const results = await dispatchAlert(sampleEvent(), baseConfig(), fakeFetch);
  assert.equal(results.length, 0);
  assert.equal(callCount, 0);
});

test("dispatchAlert only POSTs to the destinations this event's real route enables", async () => {
  const calledUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calledUrls.push(String(url));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const config = baseConfig({
    eventRoutes: {
      ...noRoutes(),
      "pause.triggered": { webhook: true, slack: true, discord: false, pagerduty: false },
    },
  });
  const results = await dispatchAlert(sampleEvent(), config, fakeFetch);
  assert.equal(results.length, 2);
  assert.ok(calledUrls.includes(config.webhookUrl));
  assert.ok(calledUrls.includes(config.slackUrl));
  assert.ok(!calledUrls.includes(config.discordUrl));
});

test("dispatchAlert skips a destination whose route is enabled but has no real URL configured", async () => {
  let callCount = 0;
  const fakeFetch = (async () => {
    callCount++;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const config = baseConfig({
    slackUrl: "", // enabled below but no real URL to send to
    eventRoutes: {
      ...noRoutes(),
      "pause.triggered": { webhook: false, slack: true, discord: false, pagerduty: false },
    },
  });
  const results = await dispatchAlert(sampleEvent(), config, fakeFetch);
  assert.equal(results.length, 0);
  assert.equal(callCount, 0);
});

test("dispatchAlert records a real non-2xx response as a failed result without throwing", async () => {
  const fakeFetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  const config = baseConfig({
    eventRoutes: {
      ...noRoutes(),
      "pause.triggered": { webhook: true, slack: false, discord: false, pagerduty: false },
    },
  });
  const results = await dispatchAlert(sampleEvent(), config, fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error!, /500/);
});

test("dispatchAlert records a real network failure as a failed result without throwing", async () => {
  const fakeFetch = (async () => {
    throw new Error("real ECONNREFUSED");
  }) as typeof fetch;
  const config = baseConfig({
    eventRoutes: {
      ...noRoutes(),
      "pause.triggered": { webhook: true, slack: false, discord: false, pagerduty: false },
    },
  });
  const results = await dispatchAlert(sampleEvent(), config, fakeFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error!, /ECONNREFUSED/);
});

test("dispatchAlert dispatches to all four destinations when every route is enabled", async () => {
  const calledUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    calledUrls.push(String(url));
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const config = baseConfig({
    eventRoutes: {
      ...noRoutes(),
      "cap.breached": { webhook: true, slack: true, discord: true, pagerduty: true },
    },
  });
  const results = await dispatchAlert(sampleEvent({ type: "cap.breached" }), config, fakeFetch);
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.ok));
  assert.ok(calledUrls.includes("https://events.pagerduty.com/v2/enqueue"));
});
