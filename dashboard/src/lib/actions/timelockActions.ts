"use client";
// Real admin-signed cancel for the "Proposal/timelock queue" panel (PRD
// 8.2). Viewing the queue needs no auth (watcher transparency); cancelling
// one does, enforced on-chain by Timelock.cancel's own admin check, not
// by this dashboard — the browser just builds and signs the real call.
import { signTransaction } from "@stellar/freighter-api";
import { Client as TimelockClient } from "dashboard-timelock-client";
import { PUBLIC_RPC_URL, PUBLIC_NETWORK_PASSPHRASE, PUBLIC_TIMELOCK_ID } from "../publicConfig";

export async function cancelProposalAsAdmin(
  proposalId: string,
  adminAddress: string,
): Promise<string> {
  const client = new TimelockClient({
    contractId: PUBLIC_TIMELOCK_ID,
    networkPassphrase: PUBLIC_NETWORK_PASSPHRASE,
    rpcUrl: PUBLIC_RPC_URL,
    publicKey: adminAddress,
    signTransaction,
  });
  const assembled = await client.cancel({ id: BigInt(proposalId), admin: adminAddress });
  const sent = await assembled.signAndSend();
  return sent.getTransactionResponse?.status ?? "unknown";
}
