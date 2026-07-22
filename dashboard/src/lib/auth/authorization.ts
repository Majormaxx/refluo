// Real on-chain authorization: maps a challenge-verified address to
// whether it is currently an R_ADMIN delegated signer or a HealthMonitor
// guardian for this dashboard's configured vault. No separate identity
// system (PRD 8.2): the vault's own real on-chain state is the source of
// truth, re-checked on every sign-in rather than cached indefinitely, so
// a revoked admin or removed guardian loses dashboard access the moment
// their on-chain rights are actually revoked.
import "server-only";
import { Client as VaultClient } from "dashboard-vault-client";
import { Client as HealthMonitorClient } from "dashboard-health-monitor-client";
import { NETWORK_PASSPHRASE, RPC_URL, VAULT_ADDRESS, HEALTH_MONITOR_ID } from "../stellar";
import { withRetry } from "../withRetry";

const R_ADMIN_CONTEXT_RULE_ID = 0;

const vault = new VaultClient({
  contractId: VAULT_ADDRESS,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

const healthMonitor = new HealthMonitorClient({
  contractId: HEALTH_MONITOR_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

/** True if `address` is currently a `Delegated` signer on the vault's
 * R_ADMIN context rule (id 0, always the admin rule by this workspace's
 * own convention, confirmed at every deploy site in this repo). A real
 * simulate call, not a cached snapshot. */
export async function isVaultAdmin(address: string): Promise<boolean> {
  const assembled = await withRetry(() =>
    vault.get_context_rule({ context_rule_id: R_ADMIN_CONTEXT_RULE_ID }),
  );
  const simulated = await withRetry(() => assembled.simulate());
  return simulated.result.signers.some(
    (signer) => signer.tag === "Delegated" && signer.values[0] === address,
  );
}

/** True if `address` currently holds the real `guardian` role on
 * HealthMonitor's `AccessControl` roster (adr/0020). */
export async function isGuardian(address: string): Promise<boolean> {
  const assembled = await withRetry(() => healthMonitor.guardians());
  const simulated = await withRetry(() => assembled.simulate());
  return simulated.result.includes(address);
}

export type DashboardRole = "admin" | "guardian";

/** Resolves the real on-chain role for a challenge-verified address.
 * Admin is checked first and wins if an address is both (an admin
 * delegated signer that also happens to be a guardian): admin is the
 * more privileged role and every guardian action is a subset of what an
 * admin can already do through other means. Returns null if the address
 * is neither, meaning it has no real standing to use this dashboard. */
export async function resolveDashboardRole(address: string): Promise<DashboardRole | null> {
  if (await isVaultAdmin(address)) {
    return "admin";
  }
  if (await isGuardian(address)) {
    return "guardian";
  }
  return null;
}
