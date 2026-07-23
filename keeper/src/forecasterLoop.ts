// Forecaster loop: real burn-event ingestion (Tier 0 SAC transfers out of
// the vault, via a real Stellar RPC getEvents query), the pure sizing
// model in forecaster.ts, and a real risk-engine.set_tier0_target write
// when the proposed target diverges from the on-chain value by more than
// a configured band. See implementation-spec §9 for the loop's original
// cadence (5min); adr/0017 covers the real integration and findings.
//
// The RPC's own event retention window is the real constraint on how much
// history this loop can ever see (confirmed live: recent runs show about
// 121k ledgers of retention, ~7 days at Stellar's ~5s ledger close time),
// which happens to match the 7-day trailing window winsorize() and the
// slow EWMA both want. Rather than persist an incremental EWMA across
// ticks (which would silently drift from what the real chain data
// actually shows), this loop recomputes both EWMAs from scratch each
// tick, replaying every hourly bucket the RPC still has. The one thing
// that genuinely cannot be recomputed from a single query is the
// hysteresis state (how long a decline has been sustained), which is
// persisted to a small local JSON file between ticks.
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  Address,
  Keypair,
  Networks,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { authorizeAndSendSmartAccountCall } from "@refluo/sdk/smartAccountAuth";
import { Client as RiskEngineClient } from "risk-engine-client";
import {
  type BurnObservation,
  type HysteresisState,
  winsorize,
  median,
  computeEwmas,
  computeTier0Target,
  applyHysteresis,
  shouldWriteOnChain,
  shouldRecall,
} from "./forecaster.js";
import { appendMetricEvent } from "./metricsLog.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}, see .env.example`);
  }
  return value;
}

const RPC_URL = requireEnv("RPC_URL");
const NETWORK_PASSPHRASE = requireEnv("NETWORK_PASSPHRASE");
const KEEPER_SECRET = requireEnv("KEEPER_SECRET");
const RISK_ENGINE_ID = requireEnv("RISK_ENGINE_ID");
const ACCOUNT = requireEnv("ACCOUNT");
const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");
const USDC_TOKEN_ID = requireEnv("USDC_TOKEN_ID");
const RECALL_WINDOW_SECONDS = Number(process.env.RECALL_WINDOW_SECONDS ?? "3600");
const FORECASTER_K = Number(process.env.FORECASTER_K ?? "1.5");
const XLM_FEE_FLOOR_USD_STROOPS = BigInt(process.env.XLM_FEE_FLOOR_USD_STROOPS ?? "1000000");
const BAND_BPS = Number(process.env.FORECASTER_BAND_BPS ?? "500");
const REFILL_BAND_BPS = Number(process.env.FORECASTER_REFILL_BAND_BPS ?? "2000");
const LOOKBACK_HOURS = Number(process.env.FORECASTER_LOOKBACK_HOURS ?? "168");
const STATE_FILE = process.env.FORECASTER_STATE_FILE ?? ".forecaster-state.json";
const RECALL_CONTEXT_RULE_ID = process.env.RECALL_CONTEXT_RULE_ID
  ? Number(process.env.RECALL_CONTEXT_RULE_ID)
  : null;
const RECALL_VENUE_ID = process.env.RECALL_VENUE_ID ?? null;
const METRICS_LOG_FILE = process.env.KEEPER_METRICS_LOG_FILE ?? ".keeper-metrics.jsonl";

const SECONDS_PER_LEDGER_APPROX = 5;

const keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);
const signer = basicNodeSigner(keeperKeypair, NETWORK_PASSPHRASE);
const server = new rpc.Server(RPC_URL);

const riskEngine = new RiskEngineClient({
  contractId: RISK_ENGINE_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: keeperKeypair.publicKey(),
  ...signer,
});

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function loadHysteresisState(): HysteresisState {
  if (!existsSync(STATE_FILE)) {
    return { belowSinceSeconds: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    // A corrupted or partially-written state file fails closed to "not
    // currently below": the next tick either raises (always safe) or
    // re-observes a decline and restarts the 24h clock, never silently
    // assumes a decline was already sustained.
    return { belowSinceSeconds: null };
  }
}

function saveHysteresisState(state: HysteresisState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

/** Real burn-event ingestion: queries the RPC for real SAC transfer
 * events where the vault is the sender, over the retained ledger range,
 * and aggregates them into hourly buckets. Returns buckets sorted oldest
 * first, one entry per hour that had at least one real transfer. */
export async function fetchHourlyBurnObservations(): Promise<BurnObservation[]> {
  const latestLedger = await server.getLatestLedger();
  const lookbackLedgers = Math.ceil(
    (LOOKBACK_HOURS * 3600) / SECONDS_PER_LEDGER_APPROX,
  );
  // A few hundred ledgers of safety margin: the RPC's real retention
  // window can shift by the time this request lands versus when
  // getLatestLedger() was read, requesting exactly the theoretical edge
  // races that boundary and fails with startLedger-out-of-range.
  const startLedger = Math.max(2, latestLedger.sequence - lookbackLedgers + 300);

  const transferTopic = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
  const fromTopic = new Address(VAULT_ADDRESS).toScVal().toXDR("base64");
  // The real USDC token's transfer event carries four topics, not the
  // three a generic SEP-41 assumption would expect: [transfer, from, to,
  // asset_code_string]. Confirmed live by reading real emitted events,
  // not assumed; a 3-element filter silently matched nothing.
  const topicFilter = [transferTopic, fromTopic, "*", "*"];

  const buckets = new Map<number, bigint>();
  let cursor: string | undefined;
  for (;;) {
    const response = await (cursor
      ? server.getEvents({
          filters: [
            {
              type: "contract",
              contractIds: [USDC_TOKEN_ID],
              topics: [topicFilter],
            },
          ],
          cursor,
          limit: 1000,
        })
      : server.getEvents({
          filters: [
            {
              type: "contract",
              contractIds: [USDC_TOKEN_ID],
              topics: [topicFilter],
            },
          ],
          startLedger,
          limit: 1000,
        }));

    for (const event of response.events) {
      if (event.value.switch().name !== "scvI128") {
        continue;
      }
      const amount = scValToI128(event.value);
      const hourBucket =
        Math.floor(new Date(event.ledgerClosedAt).getTime() / 1000 / 3600) * 3600;
      buckets.set(hourBucket, (buckets.get(hourBucket) ?? 0n) + amount);
    }

    if (response.events.length < 1000) {
      break;
    }
    cursor = response.cursor;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestampSeconds, amountStroops]) => ({ timestampSeconds, amountStroops }));
}

export async function tick(): Promise<void> {
  const tickStartSeconds = Math.floor(Date.now() / 1000);
  const observations = await fetchHourlyBurnObservations();
  log(`fetched ${observations.length} real hourly burn buckets from chain history`);

  // Winsorize each hour against the trailing 7-day median of the hours
  // strictly before it (never including itself), then feed the
  // winsorized series into both EWMAs.
  const winsorizedSeries: number[] = [];
  for (let i = 0; i < observations.length; i++) {
    const trailing = observations
      .slice(Math.max(0, i - 168), i)
      .map((o) => o.amountStroops);
    const clipped = winsorize(observations[i].amountStroops, median(trailing));
    winsorizedSeries.push(Number(clipped));
  }

  const { fastPerHour, slowPerHour } = computeEwmas(winsorizedSeries);
  log(`fast_ewma=${fastPerHour.toFixed(2)}/hr slow_ewma=${slowPerHour.toFixed(2)}/hr`);

  const computedTarget = computeTier0Target({
    fastPerHourStroops: fastPerHour,
    slowPerHourStroops: slowPerHour,
    recallWindowSeconds: RECALL_WINDOW_SECONDS,
    k: FORECASTER_K,
    xlmFeeFloorUsdStroops: XLM_FEE_FLOOR_USD_STROOPS,
  });

  const tierStateTx = await riskEngine.tier_state({ account: ACCOUNT });
  const tierState = (await tierStateTx.simulate()).result;
  const onChainTarget = tierState.tier0_target;

  // Read once per tick, alongside the tier state fetch above, purely for
  // the tier0_sample event below — reporterLoop.ts's real Agent uptime
  // metric needs the critical floor to know what threshold a sample was
  // actually being measured against, not just the sizing target.
  const configTx = await riskEngine.config({ account: ACCOUNT });
  const criticalFloor = (await configTx.simulate()).result.critical_floor;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const hysteresisState = loadHysteresisState();
  const decision = applyHysteresis(computedTarget, onChainTarget, nowSeconds, hysteresisState);
  saveHysteresisState(decision.nextState);

  log(
    `computed_target=${computedTarget} on_chain_target=${onChainTarget} ` +
      `applied_target=${decision.appliedTarget}`,
  );

  if (shouldWriteOnChain(decision.appliedTarget, onChainTarget, BAND_BPS)) {
    log(`writing new tier0_target on-chain: ${decision.appliedTarget}`);
    const assembled = await riskEngine.set_tier0_target({
      account: ACCOUNT,
      keeper: keeperKeypair.publicKey(),
      new_target: decision.appliedTarget,
    });
    const sent = await assembled.signAndSend();
    log(`set_tier0_target submitted, status=${sent.getTransactionResponse?.status ?? "unknown"}`);
  } else {
    log("proposed target within band of on-chain value, no write needed");
  }

  const tier0BalanceTx = await server.simulateTransaction(
    new TransactionBuilder(await server.getAccount(keeperKeypair.publicKey()), {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        new Contract(USDC_TOKEN_ID).call("balance", new Address(VAULT_ADDRESS).toScVal()),
      )
      .setTimeout(30)
      .build(),
  );
  if (rpc.Api.isSimulationSuccess(tier0BalanceTx)) {
    const raw = tier0BalanceTx.result?.retval;
    const tier0Balance = raw ? scValToI128(raw) : 0n;
    log(`real vault USDC balance: ${tier0Balance}`);

    // reporterLoop.ts's real Tier 0 hit-rate metric reads these samples
    // back: this tick's own real balance/target observation is more
    // frequent and no less real than a separate reporter-owned sample
    // would be, so reporter doesn't duplicate this query itself.
    appendMetricEvent(METRICS_LOG_FILE, {
      type: "tier0_sample",
      timestampSeconds: tickStartSeconds,
      balanceStroops: tier0Balance.toString(),
      targetStroops: decision.appliedTarget.toString(),
      criticalFloorStroops: criticalFloor.toString(),
    });

    if (shouldRecall(tier0Balance, decision.appliedTarget, REFILL_BAND_BPS)) {
      if (RECALL_CONTEXT_RULE_ID === null || !RECALL_VENUE_ID) {
        log(
          "tier0 balance below refill band, but RECALL_CONTEXT_RULE_ID/RECALL_VENUE_ID " +
            "are not configured, skipping the real recall this tick",
        );
      } else {
        await triggerRecall(decision.appliedTarget - tier0Balance, tickStartSeconds);
      }
    }
  }
}

function scValToI128(val: xdr.ScVal): bigint {
  const parts = val.i128();
  return (BigInt(parts.hi().toString()) << 64n) + BigInt(parts.lo().toString());
}

/** Real recall trigger: authorizes a real RecallExecutor withdraw call
 * through the vault's own R_RECALL context rule, the same
 * authorizeAndSendSmartAccountCall mechanism swap.ts already proved live
 * (adr/0016). Sized to the shortfall between the target and the real
 * current balance, capped by whatever policy-recall's own real rate
 * limits allow (a rejected over-limit call fails closed, it does not
 * retry smaller). */
async function triggerRecall(shortfall: bigint, detectedAtSeconds: number): Promise<void> {
  if (!RECALL_VENUE_ID || RECALL_CONTEXT_RULE_ID === null) {
    return;
  }
  log(`attempting a real recall for shortfall=${shortfall} from venue ${RECALL_VENUE_ID}`);
  const requestFields: [string, xdr.ScVal][] = [
    ["address", new Address(USDC_TOKEN_ID).toScVal()],
    ["amount", nativeToScVal(shortfall, { type: "i128" })],
    ["request_type", nativeToScVal(1, { type: "u32" })], // Withdraw
  ];
  const withdrawRequest = xdr.ScVal.scvMap(
    requestFields
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })),
  );
  const submitOp = new Contract(RECALL_VENUE_ID).call(
    "submit",
    new Address(VAULT_ADDRESS).toScVal(),
    new Address(VAULT_ADDRESS).toScVal(),
    new Address(VAULT_ADDRESS).toScVal(),
    xdr.ScVal.scvVec([withdrawRequest]),
  );
  const unsignedTx = new TransactionBuilder(
    await server.getAccount(keeperKeypair.publicKey()),
    { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE },
  )
    .addOperation(submitOp)
    .setTimeout(60)
    .build();

  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: VAULT_ADDRESS,
    contextRuleId: RECALL_CONTEXT_RULE_ID,
    unsignedTx,
    coSigners: [keeperKeypair],
    sourceKeypair: keeperKeypair,
  });
  log(`recall submitted through the vault, status=${result.status}`);
  appendMetricEvent(METRICS_LOG_FILE, {
    type: "recall_triggered",
    timestampSeconds: detectedAtSeconds,
    detectedAtSeconds,
    executedAtSeconds: Math.floor(Date.now() / 1000),
    shortfallStroops: shortfall.toString(),
    status: result.status,
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  const pollSeconds = Number(process.env.FORECASTER_POLL_INTERVAL_SECONDS ?? "300");
  log(`forecaster starting, polling every ${pollSeconds}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] tick failed:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("forecaster fatal error:", err);
    process.exit(1);
  });
}
