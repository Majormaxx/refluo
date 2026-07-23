// Live end-to-end verification of the alert dispatcher (adr/0023): a real
// local HTTP server standing in for webhook/Slack receivers, a real
// deployed HealthMonitor + RiskEngine, and alertDispatcherLoop.ts's real
// tick() run against all of it — not the injected-fetch unit tests, the
// actual default `fetch` path hitting a real listening server.
//   - pause.triggered: a real guardian pause() call, detected by a real
//     getEvents() query, dispatched as a real POST.
//   - recall.triggered: a real recall_triggered entry seeded through the
//     exact same appendMetricEvent function production code calls.
//   - state.transitioned: a real check_and_trip() call that actually
//     moves RiskEngine's on-chain state, detected across two real ticks.
//   - cap.breached is not exercised here: adr/0023's own finding is that
//     it has no durable event to poll for in the first place (a
//     panicking call leaves no on-chain trace), so there's nothing this
//     script could observe via the poller; dispatchAlert's own unit tests
//     already cover that payload/routing path directly.
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createServer } from "node:http";

function shOnce(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: new URL("../../", import.meta.url) }).trim();
}
function sh(cmd, attempts = 10, delayMs = 5000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return shOnce(cmd);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.log(`    (retrying after transient error: ${err.message.split("\n")[0]})`);
        execSync(`sleep ${delayMs / 1000}`);
      }
    }
  }
  throw lastErr;
}
function addressOf(identity) {
  return sh(`stellar keys address ${identity}`);
}

let pass = 0;
let fail = 0;
function check(desc, ok) {
  if (ok) {
    console.log(`    PASS: ${desc}`);
    pass++;
  } else {
    console.log(`    FAIL: ${desc}`);
    fail++;
  }
}

const keeperAddr = addressOf("refluo-testnet");

console.log("==> [1] Real local HTTP server standing in for webhook + Slack receivers");
const receivedRequests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    receivedRequests.push({ path: req.url, body: JSON.parse(body) });
    res.writeHead(200);
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const webhookUrl = `http://127.0.0.1:${port}/webhook`;
const slackUrl = `http://127.0.0.1:${port}/slack`;
console.log(`    listening on ${webhookUrl}`);

console.log("\n==> [2] Building and deploying a fresh health-monitor + risk-engine");
sh("stellar contract build --package refluo-health-monitor");
sh("stellar contract build --package refluo-risk-engine");
const healthMonitorId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
const riskEngineId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_risk_engine.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- init_guardians --admin ${keeperAddr} --guardians '["${keeperAddr}"]'`,
);
const cfg = JSON.stringify({
  oracle_router: "CBDVIRUWVWC7M2ZJH7XDJNYCURUPQMO4F3AIX24CMY43QRY5V3RCN2MX",
  oracle_asset: { Other: "XLM" },
  health_monitor: healthMonitorId,
  usdc_token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  keeper: keeperAddr,
  tier0_bounds_min: "5000000000",
  tier0_bounds_max: "20000000000",
  critical_floor: "1000000000",
  tvl_cap: "1000000000000",
  preemptive_util_bps: 8500,
  full_drain_util_bps: 9200,
});
sh(
  `stellar contract invoke --id ${riskEngineId} --source refluo-testnet --network testnet --send=yes ` +
    `-- init --account ${keeperAddr} --cfg '${cfg}' --tier0_target 10000000000`,
);
console.log(`    health-monitor: ${healthMonitorId}, risk-engine: ${riskEngineId}`);

console.log("\n==> [3] Writing a real alerts config file routing pause.triggered/recall.triggered/state.transitioned to the real local server");
const alertsConfigFile = `.alert-dispatcher-smoke-config-${Date.now()}.json`;
const off = { webhook: false, slack: false, discord: false, pagerduty: false };
writeFileSync(
  alertsConfigFile,
  JSON.stringify({
    webhookUrl,
    slackUrl,
    discordUrl: "",
    pagerdutyRoutingKey: "",
    eventRoutes: {
      "pause.triggered": { ...off, webhook: true },
      "recall.triggered": { ...off, slack: true },
      "state.transitioned": { ...off, webhook: true },
      "cap.breached": { ...off },
    },
  }),
);

const metricsLogFile = `.alert-dispatcher-smoke-metrics-${Date.now()}.jsonl`;
const stateFile = `.alert-dispatcher-smoke-state-${Date.now()}.json`;

process.env.RPC_URL =
  "https://rpc.ankr.com/stellar_testnet_soroban/56ee89fedf4300bfe1ab8c3526f776bd59090e522cb2fd36f50a2abcb6c6a09b";
process.env.NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
process.env.HEALTH_MONITOR_ID = healthMonitorId;
process.env.RISK_ENGINE_ID = riskEngineId;
process.env.ACCOUNT = keeperAddr;
process.env.ALERTS_CONFIG_FILE = alertsConfigFile;
process.env.KEEPER_METRICS_LOG_FILE = metricsLogFile;
process.env.ALERT_DISPATCHER_STATE_FILE = stateFile;

const { tick } = await import("../src/alertDispatcherLoop.ts");

console.log("\n==> [4] First tick establishes the real baseline (no prior pause, records the real Normal state)");
await tick();

console.log("\n==> [5] Real guardian pause(), then a real tick should dispatch a real pause.triggered POST");
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- pause --guardian ${keeperAddr}`,
);
await new Promise((r) => setTimeout(r, 3000));
await tick();
const pauseRequest = receivedRequests.find((r) => r.body.type === "pause.triggered");
check("a real pause.triggered POST landed at the real webhook URL", !!pauseRequest);
check(
  "the real payload names the real Guardian trigger",
  pauseRequest?.body.detail.trigger === "Guardian",
);

console.log("\n==> [6] Seeding a real recall_triggered metric event, then a real tick should dispatch to Slack");
const { appendMetricEvent } = await import("../src/metricsLog.ts");
const recallAt = Math.floor(Date.now() / 1000);
appendMetricEvent(metricsLogFile, {
  type: "recall_triggered",
  timestampSeconds: recallAt,
  detectedAtSeconds: recallAt - 10,
  executedAtSeconds: recallAt,
  shortfallStroops: "5000000",
  status: "SUCCESS",
});
await tick();
const recallRequest = receivedRequests.find((r) => r.path === "/slack");
check("a real recall.triggered POST landed at the real Slack URL", !!recallRequest);
check(
  "the real Slack payload's text names the real event type",
  recallRequest?.body.text?.includes("recall.triggered"),
);

console.log("\n==> [7] A real check_and_trip() state change, then a real tick should dispatch state.transitioned");
sh(
  `stellar contract invoke --id ${riskEngineId} --source refluo-testnet --network testnet --send=yes ` +
    `-- check_and_trip --account ${keeperAddr}`,
);
await tick();
const stateRequest = receivedRequests.find((r) => r.body.type === "state.transitioned");
check("a real state.transitioned POST landed", !!stateRequest);
check(
  "the real payload's detail names the real Normal -> Paused transition (check_and_trip escalates on the real active pause)",
  stateRequest?.body.detail.from === "Normal" && stateRequest?.body.detail.to === "Paused",
);

console.log("\n==> [8] A repeated tick with no new real events dispatches nothing further");
const countBeforeIdleTick = receivedRequests.length;
await tick();
check("an idle tick sends no further real requests", receivedRequests.length === countBeforeIdleTick);

server.close();
for (const f of [alertsConfigFile, metricsLogFile, stateFile]) {
  if (existsSync(f)) unlinkSync(f);
}

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
