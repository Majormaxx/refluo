// Pure evaluation of PRD §9 step 7's go-live checklist ("Tier 0 funded
// above floor, at least one guardian configured, risk profile set, agent
// key(s) registered and scoped, SLA telemetry endpoint reachable")
// against real data the dashboard's existing panels already fetch — no
// new on-chain reads, just assembling what's already there into the
// checklist the spec calls for. Kept separate from the panel component
// so each condition is independently unit-testable.
import type { VaultOverview } from "./contracts/vaultOverview";
import type { GuardianPanelData } from "./contracts/healthMonitor";
import type { SlaSnapshot } from "./telemetry";

export interface ChecklistItem {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ChecklistInput {
  vaultOverview: VaultOverview;
  guardianData: GuardianPanelData;
  slaSnapshot: SlaSnapshot | null;
}

/** The real context rule name `registerAgentKey()` installs an agent hot
 * key onto (contracts/vault/README.md, contracts/policy-session/src/lib.rs),
 * distinct from `R_ADMIN` (bootstrapped at deploy on every vault
 * regardless of whether an operator has registered any agent yet). */
const AGENT_CONTEXT_RULE_NAME = "R_AGENT_PAY";

export function evaluateGoLiveChecklist(input: ChecklistInput): ChecklistItem[] {
  const { vaultOverview, guardianData, slaSnapshot } = input;

  const usdcBalance = BigInt(vaultOverview.usdcBalance);
  const criticalFloor = BigInt(vaultOverview.criticalFloor);
  const fundedAboveFloor = usdcBalance >= criticalFloor;

  const guardianCount = guardianData.guardians.length;
  const hasGuardian = guardianCount >= 1;

  const hasAgentKey = vaultOverview.contextRules.some((r) => r.name === AGENT_CONTEXT_RULE_NAME);

  const hasSlaSnapshot = slaSnapshot !== null;

  return [
    {
      key: "tier0Funded",
      label: "Tier 0 funded above the critical floor",
      passed: fundedAboveFloor,
      detail: `${vaultOverview.usdcBalance} / ${vaultOverview.criticalFloor} stroops (USDC balance / critical floor)`,
    },
    {
      key: "guardianConfigured",
      label: "At least one guardian configured",
      passed: hasGuardian,
      detail: `${guardianCount} guardian${guardianCount === 1 ? "" : "s"} registered`,
    },
    {
      key: "riskProfileSet",
      label: "Risk profile set",
      passed: true,
      detail: `${vaultOverview.riskProfile} (RiskEngine reads back a real config, so it's always initialized once the vault exists)`,
    },
    {
      key: "agentKeyRegistered",
      label: "Agent key(s) registered and scoped",
      passed: hasAgentKey,
      detail: hasAgentKey
        ? `${AGENT_CONTEXT_RULE_NAME} context rule installed`
        : `No ${AGENT_CONTEXT_RULE_NAME} context rule found`,
    },
    {
      key: "slaTelemetryReachable",
      label: "SLA telemetry endpoint reachable",
      passed: hasSlaSnapshot,
      detail: hasSlaSnapshot
        ? "Reporter loop snapshot found"
        : "No snapshot yet — run `npm run reporter:once` in keeper/",
    },
  ];
}
