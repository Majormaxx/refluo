"use client";
// Real signing actions for the "Guardian/pause panel" (PRD 8.2): "the
// dashboard is a signing UI, not a privileged backend." Every
// state-changing call here is built, simulated, and signed entirely in
// the browser via the real connected wallet (Freighter); this dashboard
// never holds or transmits a private key. `dashboard-health-monitor-
// client`'s generated Client accepts a `signTransaction` callback whose
// shape is documented as "matches signature of signTransaction from
// Freighter" (stellar-sdk's own contract/types.d.ts) — Freighter's own
// export is passed straight through, no adapter needed.
import { signTransaction } from "@stellar/freighter-api";
import { Client as HealthMonitorClient } from "dashboard-health-monitor-client";
import {
  PUBLIC_RPC_URL,
  PUBLIC_NETWORK_PASSPHRASE,
  PUBLIC_HEALTH_MONITOR_ID,
} from "../publicConfig";

function client(publicKey: string): HealthMonitorClient {
  return new HealthMonitorClient({
    contractId: PUBLIC_HEALTH_MONITOR_ID,
    networkPassphrase: PUBLIC_NETWORK_PASSPHRASE,
    rpcUrl: PUBLIC_RPC_URL,
    publicKey,
    signTransaction,
  });
}

/** One-click guardian pause: the connected wallet's own address signs
 * as the guardian, real `require_auth()` HealthMonitor.pause() demands. */
export async function pauseAsGuardian(guardianAddress: string): Promise<string> {
  const assembled = await client(guardianAddress).pause({ guardian: guardianAddress });
  const sent = await assembled.signAndSend();
  return sent.getTransactionResponse?.status ?? "unknown";
}

/** Admin-gated resume before the 72h auto-expiry. */
export async function resumeEarlyAsAdmin(adminAddress: string): Promise<string> {
  const assembled = await client(adminAddress).resume_early({ admin: adminAddress });
  const sent = await assembled.signAndSend();
  return sent.getTransactionResponse?.status ?? "unknown";
}
