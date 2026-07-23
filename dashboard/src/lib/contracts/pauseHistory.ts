// Real reads backing the "Incidents" page: every past pause episode,
// event-sourced from HealthMonitor's own real Paused/Resumed/Extended
// events, the same pattern timelockProposals.ts already proved out
// (adr/0019's "read the real emitted event" pattern). The actual replay
// logic is pure and lives in pauseHistoryState.ts, kept directly
// unit-testable; this file is the real I/O around it.
import "server-only";
import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { HEALTH_MONITOR_ID, server } from "../stellar";
import { withRetry } from "../withRetry";
import { reconstructPauseHistory, type RawEvent, type PauseEpisode } from "./pauseHistoryState";

export type { PauseEpisode, PauseResolution, PauseExtensionRecord } from "./pauseHistoryState";

// Same lookback convention and real-world caveat as
// healthMonitor.ts's fetchLatestPauseExpiry: the public RPC's practical
// getEvents retention fluctuates and can be well short of a real pause's
// full 72h lifetime; a real episode older than this lookback still
// exists on-chain (readable via a real status()/event replay with a
// deeper-retention provider) but won't appear in this reconstructed list.
const LOOKBACK_LEDGERS = Number(process.env.HEALTH_MONITOR_PAUSE_LOOKBACK_LEDGERS ?? "10000");

export async function fetchPauseHistory(): Promise<PauseEpisode[]> {
  const latestLedger = await withRetry(() => server.getLatestLedger());
  const startLedger = Math.max(2, latestLedger.sequence - LOOKBACK_LEDGERS);

  const pausedTopic = xdr.ScVal.scvSymbol("paused").toXDR("base64");
  const extendedTopic = xdr.ScVal.scvSymbol("extended").toXDR("base64");
  const resumedTopic = xdr.ScVal.scvSymbol("resumed").toXDR("base64");

  const events: RawEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await withRetry(() =>
      cursor
        ? server.getEvents({
            filters: [
              {
                type: "contract",
                contractIds: [HEALTH_MONITOR_ID],
                topics: [[pausedTopic, "*"], [extendedTopic, "*"], [resumedTopic, "*"]],
              },
            ],
            cursor,
            limit: 1000,
          })
        : server.getEvents({
            filters: [
              {
                type: "contract",
                contractIds: [HEALTH_MONITOR_ID],
                topics: [[pausedTopic, "*"], [extendedTopic, "*"], [resumedTopic, "*"]],
              },
            ],
            startLedger,
            limit: 1000,
          }),
    );

    for (const event of response.events) {
      const topicName = scValToNative(event.topic[0]) as string;
      const atSeconds = Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000);
      if (topicName === "paused") {
        const trigger = (scValToNative(event.topic[1]) as string[])[0];
        const data = scValToNative(event.value) as { pause_expiry: bigint };
        events.push({
          type: "paused",
          atSeconds,
          trigger,
          pauseExpirySeconds: Number(data.pause_expiry),
        });
      } else if (topicName === "extended") {
        const extensionsUsed = Number(scValToNative(event.topic[1]) as number | bigint);
        const data = scValToNative(event.value) as { pause_expiry: bigint };
        events.push({
          type: "extended",
          atSeconds,
          extensionsUsed,
          pauseExpirySeconds: Number(data.pause_expiry),
        });
      } else {
        events.push({ type: "resumed", atSeconds });
      }
    }
    if (response.events.length < 1000) {
      break;
    }
    cursor = response.cursor;
  }

  return reconstructPauseHistory(events, Math.floor(Date.now() / 1000));
}
