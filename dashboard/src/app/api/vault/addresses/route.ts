import { NextResponse } from "next/server";
import {
  VAULT_ADDRESS,
  RISK_ENGINE_ID,
  HEALTH_MONITOR_ID,
  TIMELOCK_ID,
  USDC_TOKEN_ID,
  XLM_TOKEN_ID,
} from "@/lib/stellar";
import { fetchVaultOverview } from "@/lib/contracts/vaultOverview";
import { withErrorHandling } from "@/lib/apiError";

// Deliberately no auth check. PRD §11's self-rescue guarantee's own
// documentation obligation: the vault's admin addresses and every
// deployed contract address must be independently recoverable from
// on-chain data alone, not solely from Refluo's own database — these are
// public contract IDs, not secrets (same reasoning publicConfig.ts
// already documents for the client-side equivalents).
export async function GET() {
  return withErrorHandling(async () => {
    const overview = await fetchVaultOverview();
    return NextResponse.json({
      vaultAddress: VAULT_ADDRESS,
      riskEngineId: RISK_ENGINE_ID,
      healthMonitorId: HEALTH_MONITOR_ID,
      timelockId: TIMELOCK_ID,
      usdcTokenId: USDC_TOKEN_ID,
      xlmTokenId: XLM_TOKEN_ID,
      contextRules: overview.contextRules,
    });
  });
}
