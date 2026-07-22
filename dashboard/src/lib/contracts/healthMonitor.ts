// Real reads backing the "Guardian/pause panel" (PRD 8.2): current pause
// status, the real countdown to auto-expiry, and the real guardian
// roster. pause_expiry has no direct getter on HealthMonitor (only
// status()'s boolean), so this reads it from the real emitted `Paused`
// event instead, the exact same real event shape (topics: ["paused",
// [trigger]], value: {pause_expiry}) reporterLoop.ts already confirmed
// live and decodes (adr/0019) — reused here, not re-derived.
import "server-only";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { Client as HealthMonitorClient } from "dashboard-health-monitor-client";
import { NETWORK_PASSPHRASE, RPC_URL, HEALTH_MONITOR_ID, server } from "../stellar";
import { withRetry } from "../withRetry";

const healthMonitor = new HealthMonitorClient({
  contractId: HEALTH_MONITOR_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

export interface GuardianPanelData {
  healthMonitorId: string;
  paused: boolean;
  pauseExpirySeconds: number | null;
  guardians: string[];
}

// Real finding: the public testnet RPC's practical getEvents retention
// is not a fixed ~121,000-ledger (~7 day) figure the way adr/0017 found
// under different conditions, it fluctuates (provider/load-balancer
// dependent) and can be much shorter — confirmed live here by
// binary-searching a real deployed HealthMonitor's own Paused event
// across two separate rounds: the safe/unsafe boundary sat between
// 10,000-20,000 ledgers back in one round and, minutes later against a
// second fresh deployment, had already moved to between 10,000-15,000.
// A too-far-back query fails two different ways depending on exactly how
// far past the real boundary it lands: a hard "startLedger out of range"
// RPC error for a very large window, or a silent empty result (no error
// at all) for a moderately-too-large one — confirmed both, live. 10,000
// ledgers back was the one value that held in both rounds, so that is
// the default here, not a larger "probably safe" number. A real pause
// can legitimately be up to 72h old (MAX_PAUSE_DURATION); when this
// lookback can't reach that far back on the operator's own RPC provider,
// pauseExpirySeconds comes back null (status() itself, sourced directly
// from contract storage rather than events, is never affected). Operators
// on an RPC provider with deeper, more stable retention can raise this.
const LOOKBACK_LEDGERS = Number(process.env.HEALTH_MONITOR_PAUSE_LOOKBACK_LEDGERS ?? "10000");

/** The most recent real `Paused` event's `pause_expiry`, or null if none
 * within the lookback window (either never paused, or the last pause is
 * old enough that its own auto-expiry has certainly already passed). */
async function fetchLatestPauseExpiry(): Promise<number | null> {
  const latestLedger = await withRetry(() => server.getLatestLedger());
  const startLedger = Math.max(2, latestLedger.sequence - LOOKBACK_LEDGERS);
  const pausedTopic = xdr.ScVal.scvSymbol("paused").toXDR("base64");

  let latestExpiry: number | null = null;
  let cursor: string | undefined;
  for (;;) {
    const response = await withRetry(() =>
      cursor
        ? server.getEvents({
            filters: [
              { type: "contract", contractIds: [HEALTH_MONITOR_ID], topics: [[pausedTopic, "*"]] },
            ],
            cursor,
            limit: 1000,
          })
        : server.getEvents({
            filters: [
              { type: "contract", contractIds: [HEALTH_MONITOR_ID], topics: [[pausedTopic, "*"]] },
            ],
            startLedger,
            limit: 1000,
          }),
    );

    for (const event of response.events) {
      const data = scValToNative(event.value) as { pause_expiry: bigint };
      latestExpiry = Number(data.pause_expiry);
    }
    if (response.events.length < 1000) {
      break;
    }
    cursor = response.cursor;
  }
  return latestExpiry;
}

export async function fetchGuardianPanelData(): Promise<GuardianPanelData> {
  const [statusTx, guardiansTx] = await Promise.all([
    healthMonitor.status(),
    healthMonitor.guardians(),
  ]);
  const [paused, guardians] = await Promise.all([
    withRetry(() => statusTx.simulate()).then((r) => r.result),
    withRetry(() => guardiansTx.simulate()).then((r) => r.result),
  ]);

  const pauseExpirySeconds = paused ? await fetchLatestPauseExpiry() : null;

  return {
    healthMonitorId: HEALTH_MONITOR_ID,
    paused,
    pauseExpirySeconds,
    guardians,
  };
}
