import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAlertsConfigPatch } from "./alertsConfigValidation.js";

test("validateAlertsConfigPatch accepts a fully empty patch", () => {
  assert.equal(validateAlertsConfigPatch({}), null);
});

test("validateAlertsConfigPatch accepts real valid https URLs", () => {
  assert.equal(
    validateAlertsConfigPatch({
      webhookUrl: "https://example.com/hook",
      slackUrl: "https://hooks.slack.com/services/x",
    }),
    null,
  );
});

test("validateAlertsConfigPatch accepts an empty string for a URL field (clearing it)", () => {
  assert.equal(validateAlertsConfigPatch({ webhookUrl: "" }), null);
});

test("validateAlertsConfigPatch rejects a non-object body", () => {
  assert.notEqual(validateAlertsConfigPatch(null), null);
  assert.notEqual(validateAlertsConfigPatch("a string"), null);
  assert.notEqual(validateAlertsConfigPatch(42), null);
  assert.notEqual(validateAlertsConfigPatch([]), null);
});

test("validateAlertsConfigPatch rejects an unknown field", () => {
  const error = validateAlertsConfigPatch({ notARealField: "x" });
  assert.match(error!, /unknown field/);
});

test("validateAlertsConfigPatch rejects a non-string value for a known field", () => {
  const error = validateAlertsConfigPatch({ webhookUrl: 123 });
  assert.match(error!, /must be a string/);
});

test("validateAlertsConfigPatch rejects a malformed URL", () => {
  const error = validateAlertsConfigPatch({ webhookUrl: "not a url" });
  assert.match(error!, /not a valid URL/);
});

test("validateAlertsConfigPatch rejects a non-http(s) URL scheme", () => {
  const error = validateAlertsConfigPatch({ webhookUrl: "javascript:alert(1)" });
  assert.match(error!, /http\(s\)/);
});

test("validateAlertsConfigPatch does not URL-validate pagerdutyRoutingKey", () => {
  assert.equal(validateAlertsConfigPatch({ pagerdutyRoutingKey: "not-a-url-at-all" }), null);
});

test("validateAlertsConfigPatch accepts a real, fully-specified eventRoutes object", () => {
  assert.equal(
    validateAlertsConfigPatch({
      eventRoutes: {
        "pause.triggered": { webhook: true, slack: false, discord: false, pagerduty: true },
        "recall.triggered": { webhook: false, slack: false, discord: false, pagerduty: false },
        "state.transitioned": { webhook: false, slack: true, discord: false, pagerduty: false },
        "cap.breached": { webhook: false, slack: false, discord: false, pagerduty: false },
      },
    }),
    null,
  );
});

test("validateAlertsConfigPatch accepts a partial eventRoutes object", () => {
  assert.equal(
    validateAlertsConfigPatch({
      eventRoutes: { "pause.triggered": { webhook: true, slack: false, discord: false, pagerduty: false } },
    }),
    null,
  );
});

test("validateAlertsConfigPatch rejects an unknown event type in eventRoutes", () => {
  const error = validateAlertsConfigPatch({
    eventRoutes: { "not.a.real.event": { webhook: true, slack: false, discord: false, pagerduty: false } },
  });
  assert.match(error!, /unknown event type/);
});

test("validateAlertsConfigPatch rejects an unknown destination in eventRoutes", () => {
  const error = validateAlertsConfigPatch({
    eventRoutes: { "pause.triggered": { webhook: true, telegram: true } },
  });
  assert.match(error!, /unknown destination/);
});

test("validateAlertsConfigPatch rejects a non-boolean destination value in eventRoutes", () => {
  const error = validateAlertsConfigPatch({
    eventRoutes: { "pause.triggered": { webhook: "yes" } },
  });
  assert.match(error!, /must be a boolean/);
});

test("validateAlertsConfigPatch rejects a non-object eventRoutes", () => {
  const error = validateAlertsConfigPatch({ eventRoutes: "not an object" });
  assert.match(error!, /eventRoutes must be a JSON object/);
});
