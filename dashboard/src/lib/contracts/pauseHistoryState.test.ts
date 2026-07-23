import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructPauseHistory } from "./pauseHistoryState";

test("reconstructPauseHistory returns nothing for an empty event list", () => {
  assert.deepEqual(reconstructPauseHistory([], 1000), []);
});

test("reconstructPauseHistory closes a real pause as resumed_early", () => {
  const episodes = reconstructPauseHistory(
    [
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 100 + 72 * 3600 },
      { type: "resumed", atSeconds: 200 },
    ],
    1000,
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].resolution, "resumed_early");
  assert.equal(episodes[0].resolvedAtSeconds, 200);
  assert.equal(episodes[0].pausedAtSeconds, 100);
});

test("reconstructPauseHistory records real extensions and their moved expiry", () => {
  const episodes = reconstructPauseHistory(
    [
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 200 },
      { type: "extended", atSeconds: 150, extensionsUsed: 1, pauseExpirySeconds: 350 },
      { type: "extended", atSeconds: 300, extensionsUsed: 2, pauseExpirySeconds: 500 },
      { type: "resumed", atSeconds: 400 },
    ],
    1000,
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].extensions.length, 2);
  assert.equal(episodes[0].extensions[1].extensionsUsed, 2);
  assert.equal(episodes[0].finalPauseExpirySeconds, 500);
  assert.equal(episodes[0].resolution, "resumed_early");
});

test("reconstructPauseHistory marks a still-open episode active when now hasn't reached its expiry", () => {
  const episodes = reconstructPauseHistory(
    [{ type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 1000 }],
    500,
  );
  assert.equal(episodes[0].resolution, "active");
  assert.equal(episodes[0].resolvedAtSeconds, null);
});

test("reconstructPauseHistory marks a still-open episode auto_expired once now passes its expiry", () => {
  const episodes = reconstructPauseHistory(
    [{ type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 1000 }],
    1500,
  );
  assert.equal(episodes[0].resolution, "auto_expired");
  assert.equal(episodes[0].resolvedAtSeconds, 1000);
});

test("reconstructPauseHistory: a real re-trigger while still genuinely paused supersedes the open episode", () => {
  // pause() has no re-pause guard (adr/0022) — a second real Paused event
  // can land before the first one ever resolves. The re-trigger happens
  // at 150, well before the first episode's own expiry (1000).
  const episodes = reconstructPauseHistory(
    [
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 1000 },
      { type: "paused", atSeconds: 150, trigger: "Guardian", pauseExpirySeconds: 1150 },
    ],
    2000,
  );
  assert.equal(episodes.length, 2);
  const [mostRecent, superseded] = episodes; // reversed: most recent first
  assert.equal(superseded.resolution, "superseded");
  assert.equal(superseded.resolvedAtSeconds, 150, "cut short by the real re-trigger, not its own expiry");
  assert.equal(mostRecent.pausedAtSeconds, 150);
});

test("reconstructPauseHistory: a re-trigger after the prior episode already lapsed is auto_expired, not superseded", () => {
  // The re-trigger at 1200 happens *after* the first episode's own expiry
  // (1000) already passed — it genuinely auto-expired first.
  const episodes = reconstructPauseHistory(
    [
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 1000 },
      { type: "paused", atSeconds: 1200, trigger: "Guardian", pauseExpirySeconds: 1200 + 72 * 3600 },
    ],
    5000,
  );
  const [, first] = episodes;
  assert.equal(first.resolution, "auto_expired");
  assert.equal(first.resolvedAtSeconds, 1000, "resolves at its own real expiry, not the later re-trigger's time");
});

test("reconstructPauseHistory returns episodes most-recent-first", () => {
  const episodes = reconstructPauseHistory(
    [
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 200 },
      { type: "resumed", atSeconds: 150 },
      { type: "paused", atSeconds: 300, trigger: "Guardian", pauseExpirySeconds: 400 },
      { type: "resumed", atSeconds: 350 },
    ],
    1000,
  );
  assert.equal(episodes.length, 2);
  assert.equal(episodes[0].pausedAtSeconds, 300);
  assert.equal(episodes[1].pausedAtSeconds, 100);
});

test("reconstructPauseHistory ignores a stray Extended/Resumed event with no open episode", () => {
  const episodes = reconstructPauseHistory(
    [
      { type: "extended", atSeconds: 50, extensionsUsed: 1, pauseExpirySeconds: 500 },
      { type: "resumed", atSeconds: 60 },
      { type: "paused", atSeconds: 100, trigger: "Guardian", pauseExpirySeconds: 200 },
    ],
    150,
  );
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].extensions.length, 0);
});
