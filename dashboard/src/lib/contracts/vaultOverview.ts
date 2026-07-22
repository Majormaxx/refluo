// Real reads backing the "Vault overview" panel (PRD 8.2): tier
// balances, current SystemState, active risk profile inputs, and every
// context rule's own signers/expiry (the "agent keys and their expiry"
// requirement — the vault's own real context rules are that data,
// nothing else needs to be queried for it).
import "server-only";
import { Client as VaultClient } from "dashboard-vault-client";
import { Client as RiskEngineClient, SystemState, type TierState } from "dashboard-risk-engine-client";
import { Client as TokenClient } from "dashboard-token-client";
import {
  NETWORK_PASSPHRASE,
  RPC_URL,
  VAULT_ADDRESS,
  RISK_ENGINE_ID,
  RISK_ENGINE_ACCOUNT,
  USDC_TOKEN_ID,
  XLM_TOKEN_ID,
} from "../stellar";
import { withRetry } from "../withRetry";
import { deriveRiskProfileLabel, type RiskProfileLabel } from "./riskProfile";

const vault = new VaultClient({
  contractId: VAULT_ADDRESS,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});
const riskEngine = new RiskEngineClient({
  contractId: RISK_ENGINE_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});
const usdcToken = new TokenClient({
  contractId: USDC_TOKEN_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});
const xlmToken = new TokenClient({
  contractId: XLM_TOKEN_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

export interface ContextRuleSummary {
  id: number;
  name: string;
  validUntilLedger: number | null;
  delegatedSigners: string[];
  policies: string[];
}

export interface VaultOverview {
  vaultAddress: string;
  systemState: keyof typeof SystemState;
  tier0Target: string;
  tier1Positions: Array<{ venue: string; amount: string }>;
  usdcBalance: string;
  xlmBalance: string;
  contextRules: ContextRuleSummary[];
  riskProfile: RiskProfileLabel;
  criticalFloor: string;
}

export interface VaultStatus {
  vaultAddress: string;
  systemState: keyof typeof SystemState;
  tier0Target: string;
  usdcBalance: string;
}

/** Just the two real reads the status bar needs (system state, address)
 * plus the tier0 numbers it displays a hit-rate style summary from.
 * Deliberately skips the get_context_rules_count()/get_context_rule()
 * N+1 loop fetchVaultOverview() does for the full panel — that loop is
 * the real reason /api/vault/overview takes seconds, and the status bar
 * polls on an interval, so it needs a cheap call, not the expensive one
 * duplicated. */
export async function fetchVaultStatus(): Promise<VaultStatus> {
  const [stateTx, tierStateTx, usdcBalanceTx] = await Promise.all([
    withRetry(() => riskEngine.state({ account: RISK_ENGINE_ACCOUNT })),
    withRetry(() => riskEngine.tier_state({ account: RISK_ENGINE_ACCOUNT })),
    withRetry(() => usdcToken.balance({ id: VAULT_ADDRESS })),
  ]);
  const [state, tierState, usdcBalance] = await Promise.all([
    withRetry(() => stateTx.simulate()).then((r) => r.result),
    withRetry(() => tierStateTx.simulate()).then((r) => r.result as TierState),
    withRetry(() => usdcBalanceTx.simulate()).then((r) => r.result),
  ]);
  return {
    vaultAddress: VAULT_ADDRESS,
    systemState: SystemState[state] as keyof typeof SystemState,
    tier0Target: tierState.tier0_target.toString(),
    usdcBalance: usdcBalance.toString(),
  };
}

export async function fetchVaultOverview(): Promise<VaultOverview> {
  const [stateTx, tierStateTx, configTx, usdcBalanceTx, xlmBalanceTx, ruleCountTx] = await Promise.all([
    withRetry(() => riskEngine.state({ account: RISK_ENGINE_ACCOUNT })),
    withRetry(() => riskEngine.tier_state({ account: RISK_ENGINE_ACCOUNT })),
    withRetry(() => riskEngine.config({ account: RISK_ENGINE_ACCOUNT })),
    withRetry(() => usdcToken.balance({ id: VAULT_ADDRESS })),
    withRetry(() => xlmToken.balance({ id: VAULT_ADDRESS })),
    withRetry(() => vault.get_context_rules_count()),
  ]);

  const [state, tierState, config, usdcBalance, xlmBalance, ruleCount] = await Promise.all([
    withRetry(() => stateTx.simulate()).then((r) => r.result),
    withRetry(() => tierStateTx.simulate()).then((r) => r.result as TierState),
    withRetry(() => configTx.simulate()).then((r) => r.result),
    withRetry(() => usdcBalanceTx.simulate()).then((r) => r.result),
    withRetry(() => xlmBalanceTx.simulate()).then((r) => r.result),
    withRetry(() => ruleCountTx.simulate()).then((r) => r.result),
  ]);

  const riskProfile = deriveRiskProfileLabel({
    preemptiveUtilBps: config.preemptive_util_bps,
    fullDrainUtilBps: config.full_drain_util_bps,
  });

  const contextRules: ContextRuleSummary[] = [];
  for (let id = 0; id < Number(ruleCount); id++) {
    const ruleTx = await withRetry(() => vault.get_context_rule({ context_rule_id: id }));
    const rule = (await withRetry(() => ruleTx.simulate())).result;
    contextRules.push({
      id: rule.id,
      name: rule.name,
      validUntilLedger: rule.valid_until ?? null,
      delegatedSigners: rule.signers
        .filter((s) => s.tag === "Delegated")
        .map((s) => s.values[0]),
      policies: rule.policies,
    });
  }

  return {
    vaultAddress: VAULT_ADDRESS,
    systemState: SystemState[state] as keyof typeof SystemState,
    tier0Target: tierState.tier0_target.toString(),
    tier1Positions: [...tierState.tier1_positions.entries()].map(([venue, amount]) => ({
      venue,
      amount: amount.toString(),
    })),
    usdcBalance: usdcBalance.toString(),
    xlmBalance: xlmBalance.toString(),
    contextRules,
    riskProfile,
    criticalFloor: config.critical_floor.toString(),
  };
}
