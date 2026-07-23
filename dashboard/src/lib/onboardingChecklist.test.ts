import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGoLiveChecklist, type ChecklistInput } from "./onboardingChecklist";
import type { VaultOverview } from "./contracts/vaultOverview";
import type { GuardianPanelData } from "./contracts/healthMonitor";

function baseVaultOverview(overrides: Partial<VaultOverview> = {}): VaultOverview {
  return {
    vaultAddress: "GVAULT",
    systemState: "Normal",
    tier0Target: "100",
    tier1Positions: [],
    usdcBalance: "200",
    xlmBalance: "50",
    contextRules: [{ id: 0, name: "R_ADMIN", validUntilLedger: null, delegatedSigners: [], policies: [] }],
    riskProfile: "Balanced",
    criticalFloor: "100",
    ...overrides,
  };
}

function baseGuardianData(overrides: Partial<GuardianPanelData> = {}): GuardianPanelData {
  return {
    healthMonitorId: "GHM",
    paused: false,
    pauseExpirySeconds: null,
    guardians: ["GGUARDIAN"],
    ...overrides,
  };
}

function baseInput(overrides: Partial<ChecklistInput> = {}): ChecklistInput {
  return {
    vaultOverview: baseVaultOverview(),
    guardianData: baseGuardianData(),
    slaSnapshot: null,
    ...overrides,
  };
}

function itemByKey(items: ReturnType<typeof evaluateGoLiveChecklist>, key: string) {
  const item = items.find((i) => i.key === key);
  assert.ok(item, `expected a checklist item with key ${key}`);
  return item!;
}

test("tier0Funded passes when the real USDC balance is at or above the real critical floor", () => {
  const items = evaluateGoLiveChecklist(
    baseInput({ vaultOverview: baseVaultOverview({ usdcBalance: "100", criticalFloor: "100" }) }),
  );
  assert.equal(itemByKey(items, "tier0Funded").passed, true);
});

test("tier0Funded fails when the real USDC balance is below the real critical floor", () => {
  const items = evaluateGoLiveChecklist(
    baseInput({ vaultOverview: baseVaultOverview({ usdcBalance: "99", criticalFloor: "100" }) }),
  );
  assert.equal(itemByKey(items, "tier0Funded").passed, false);
});

test("guardianConfigured fails with zero real guardians", () => {
  const items = evaluateGoLiveChecklist(baseInput({ guardianData: baseGuardianData({ guardians: [] }) }));
  assert.equal(itemByKey(items, "guardianConfigured").passed, false);
});

test("guardianConfigured passes with at least one real guardian", () => {
  const items = evaluateGoLiveChecklist(baseInput());
  assert.equal(itemByKey(items, "guardianConfigured").passed, true);
});

test("agentKeyRegistered fails when only the always-present R_ADMIN rule exists", () => {
  const items = evaluateGoLiveChecklist(baseInput());
  assert.equal(itemByKey(items, "agentKeyRegistered").passed, false);
});

test("agentKeyRegistered passes once a real R_AGENT_PAY context rule is installed", () => {
  const items = evaluateGoLiveChecklist(
    baseInput({
      vaultOverview: baseVaultOverview({
        contextRules: [
          { id: 0, name: "R_ADMIN", validUntilLedger: null, delegatedSigners: [], policies: [] },
          { id: 1, name: "R_AGENT_PAY", validUntilLedger: 999, delegatedSigners: ["GAGENT"], policies: ["policy-session"] },
        ],
      }),
    }),
  );
  assert.equal(itemByKey(items, "agentKeyRegistered").passed, true);
});

test("slaTelemetryReachable fails when the reporter loop hasn't produced a real snapshot yet", () => {
  const items = evaluateGoLiveChecklist(baseInput({ slaSnapshot: null }));
  assert.equal(itemByKey(items, "slaTelemetryReachable").passed, false);
});

test("slaTelemetryReachable passes once a real snapshot exists", () => {
  const items = evaluateGoLiveChecklist(
    baseInput({
      slaSnapshot: {
        generatedAtSeconds: 1,
        windowStartSeconds: 0,
        windowEndSeconds: 1,
        tier0HitRate: 1,
        agentUptime: 1,
        pauseStats: { pauseCount: 0, totalPauseDurationSeconds: 0 },
        recallLatency: { count: 0, p50Seconds: 0, p95Seconds: 0, p99Seconds: 0, buckets: [] },
        forecasterError: { count: 0, meanAbsErrorStroopsPerHour: 0, meanAbsPercentError: 0, p99AbsErrorStroopsPerHour: 0 },
        tier0Series: [],
        forecasterErrorSeries: [],
      },
    }),
  );
  assert.equal(itemByKey(items, "slaTelemetryReachable").passed, true);
});

test("riskProfileSet always passes: RiskEngine.config() only ever resolves once the account is real and initialized", () => {
  const items = evaluateGoLiveChecklist(baseInput());
  assert.equal(itemByKey(items, "riskProfileSet").passed, true);
});

test("evaluateGoLiveChecklist returns exactly the five PRD 9.7 conditions", () => {
  const items = evaluateGoLiveChecklist(baseInput());
  assert.deepEqual(
    items.map((i) => i.key).sort(),
    [
      "agentKeyRegistered",
      "guardianConfigured",
      "riskProfileSet",
      "slaTelemetryReachable",
      "tier0Funded",
    ].sort(),
  );
});
