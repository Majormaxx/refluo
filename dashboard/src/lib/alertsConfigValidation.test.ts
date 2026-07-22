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
