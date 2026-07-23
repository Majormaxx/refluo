// Real integration for alertDispatcher.ts's 3 pollable event types
// (pause.triggered, recall.triggered, state.transitioned — cap.breached
// has no durable event to poll, adr/0023's own finding, dispatched inline
// by whichever real call site observes the rejection instead). Reads the
// same real alerts config file the dashboard's alertsConfig.ts writes
// (ALERTS_CONFIG_FILE, matching the reporter snapshot's shared-file
// integration pattern, adr/0019) and a small local high-water-mark state
// file (same convention as forecasterLoop.ts's own hysteresis state)
// tracking what's already been dispatched, so a restart doesn't re-fire
// every historical event.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as RiskEngineClient, SystemState } from "risk-engine-client";
import { dispatchAlert, type AlertsConfig } from "./alertDispatcher.js";
import { readMetricEvents } from "./metricsLog.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}, see .env.example`);
  }
  return value;
}

const RPC_URL = requireEnv("RPC_URL");
const NETWORK_PASSPHRASE = requireEnv("NETWORK_PASSPHRASE");
const HEALTH_MONITOR_ID = requireEnv("HEALTH_MONITOR_ID");
const RISK_ENGINE_ID = requireEnv("RISK_ENGINE_ID");
const ACCOUNT = requireEnv("ACCOUNT");
const METRICS_LOG_FILE = process.env.KEEPER_METRICS_LOG_FILE ?? ".keeper-metrics.jsonl";
const ALERTS_CONFIG_FILE = process.env.ALERTS_CONFIG_FILE ?? ".alerts-config.json";
const STATE_FILE = process.env.ALERT_DISPATCHER_STATE_FILE ?? ".alert-dispatcher-state.json";

const SECONDS_PER_LEDGER_APPROX = 5;
// Same real-world ceiling this exact event type's other consumers already
// found and documented (healthMonitor.ts's own header comment,
// pauseHistory.ts): the public RPC's practical getEvents retention
// fluctuates and can be well short of what a naive Date.now()-derived
// lookback would compute — a first tick (sinceSeconds=0) or a long-idle
// restart must not try to reach back to the Unix epoch.
const MAX_LOOKBACK_LEDGERS = Number(process.env.ALERT_DISPATCHER_PAUSE_LOOKBACK_LEDGERS ?? "10000");

const server = new rpc.Server(RPC_URL);
const riskEngine = new RiskEngineClient({
  contractId: RISK_ENGINE_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
});

function log(message: string): void {
  console.log(`[alert-dispatcher] ${new Date().toISOString()} ${message}`);
}

interface DispatcherState {
  lastPauseAtSeconds: number;
  lastRecallAtSeconds: number;
  lastKnownSystemState: number | null;
}

function loadState(): DispatcherState {
  if (!existsSync(STATE_FILE)) {
    return { lastPauseAtSeconds: 0, lastRecallAtSeconds: 0, lastKnownSystemState: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastPauseAtSeconds: 0, lastRecallAtSeconds: 0, lastKnownSystemState: null };
  }
}

function saveState(state: DispatcherState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadAlertsConfig(): AlertsConfig | null {
  if (!existsSync(ALERTS_CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(ALERTS_CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** New real HealthMonitor Paused events since `sinceSeconds`, same real
 * event shape reporterLoop.ts/pauseHistory.ts already confirmed live
 * (topics: ["paused", [trigger_tag]], value: {pause_expiry}). */
async function fetchNewPauseEvents(
  sinceSeconds: number,
): Promise<Array<{ atSeconds: number; trigger: string }>> {
  const latestLedger = await server.getLatestLedger();
  const lookbackSeconds = Math.max(0, Math.floor(Date.now() / 1000) - sinceSeconds);
  const lookbackLedgers = Math.min(
    MAX_LOOKBACK_LEDGERS,
    Math.max(300, Math.ceil(lookbackSeconds / SECONDS_PER_LEDGER_APPROX) + 300),
  );
  const startLedger = Math.max(2, latestLedger.sequence - lookbackLedgers);
  const pausedTopic = xdr.ScVal.scvSymbol("paused").toXDR("base64");

  const found: Array<{ atSeconds: number; trigger: string }> = [];
  let cursor: string | undefined;
  for (;;) {
    const response = await (cursor
      ? server.getEvents({
          filters: [{ type: "contract", contractIds: [HEALTH_MONITOR_ID], topics: [[pausedTopic, "*"]] }],
          cursor,
          limit: 1000,
        })
      : server.getEvents({
          filters: [{ type: "contract", contractIds: [HEALTH_MONITOR_ID], topics: [[pausedTopic, "*"]] }],
          startLedger,
          limit: 1000,
        }));
    for (const event of response.events) {
      const atSeconds = Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000);
      if (atSeconds > sinceSeconds) {
        const trigger = (scValToNative(event.topic[1]) as string[])[0];
        found.push({ atSeconds, trigger });
      }
    }
    if (response.events.length < 1000) break;
    cursor = response.cursor;
  }
  return found.sort((a, b) => a.atSeconds - b.atSeconds);
}

export async function tick(): Promise<void> {
  const config = loadAlertsConfig();
  if (!config) {
    log("no real alerts config file found yet, nothing to dispatch against");
    return;
  }
  const state = loadState();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const newPauses = await fetchNewPauseEvents(state.lastPauseAtSeconds);
  for (const pause of newPauses) {
    await dispatchAlert(
      {
        type: "pause.triggered",
        atSeconds: pause.atSeconds,
        summary: `HealthMonitor paused (trigger: ${pause.trigger})`,
        detail: { trigger: pause.trigger },
      },
      config,
    );
    state.lastPauseAtSeconds = pause.atSeconds;
  }
  if (newPauses.length > 0) {
    log(`dispatched ${newPauses.length} real pause.triggered alert(s)`);
  }

  const newRecalls = readMetricEvents(METRICS_LOG_FILE).filter(
    (e) => e.type === "recall_triggered" && e.timestampSeconds > state.lastRecallAtSeconds,
  );
  for (const recall of newRecalls) {
    await dispatchAlert(
      {
        type: "recall.triggered",
        atSeconds: recall.timestampSeconds,
        summary: "Recall triggered",
        detail: { shortfallStroops: recall.shortfallStroops, status: recall.status },
      },
      config,
    );
    state.lastRecallAtSeconds = Math.max(state.lastRecallAtSeconds, recall.timestampSeconds);
  }
  if (newRecalls.length > 0) {
    log(`dispatched ${newRecalls.length} real recall.triggered alert(s)`);
  }

  const stateTx = await riskEngine.state({ account: ACCOUNT });
  const currentState = (await stateTx.simulate()).result;
  if (state.lastKnownSystemState !== null && currentState !== state.lastKnownSystemState) {
    const fromName = SystemState[state.lastKnownSystemState];
    const toName = SystemState[currentState];
    await dispatchAlert(
      {
        type: "state.transitioned",
        atSeconds: nowSeconds,
        summary: `RiskEngine state changed: ${fromName} -> ${toName}`,
        detail: { from: fromName, to: toName },
      },
      config,
    );
    log(`dispatched real state.transitioned alert: ${fromName} -> ${toName}`);
  }
  state.lastKnownSystemState = currentState;

  saveState(state);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  const pollSeconds = Number(process.env.ALERT_DISPATCHER_POLL_INTERVAL_SECONDS ?? "60");
  log(`alert dispatcher starting, polling every ${pollSeconds}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log(`tick failed: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
