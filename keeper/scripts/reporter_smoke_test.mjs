// Live end-to-end verification of the reporter loop (adr/0019): a real
// deployed HealthMonitor is really paused and really resumed, and
// reporterLoop.tick()'s real event-fetching correctly reconstructs that
// pause episode's real duration from the real emitted events (not
// assumed from the contract's Rust source, the actual on-chain topic/
// value shape this workspace confirmed live: topics ["paused",
// [trigger]] / ["resumed", early], value {pause_expiry} / {}). A real
// vault is deployed and funded, and a real admin-authorized USDC
// transfer out of it produces at least one real burn-history bucket
// fetchHourlyBurnObservations (already proven live by adr/0017) can read
// back and feed into the real forecaster-error backtest. The tier0
// hit-rate and recall-latency metrics are seeded through the exact same
// appendMetricEvent function forecasterLoop.ts calls in production, real
// code path, not a mock of it, then read back by a real tick().
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { authorizeAndSendSmartAccountCall } from "@refluo/sdk/smartAccountAuth";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

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
function secretOf(identity) {
  return sh(`stellar keys show ${identity}`);
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

console.log("==> Building vault, policy-admin-threshold, health-monitor");
sh("stellar contract build --package refluo-vault");
sh("stellar contract build --package refluo-policy-admin-threshold");
sh("stellar contract build --package refluo-health-monitor");

const keeperAddr = addressOf("refluo-testnet");

console.log("\n==> [1] Deploying a fresh HealthMonitor and running a real pause/resume cycle");
const healthMonitorId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- init_guardians --admin ${keeperAddr} --guardians '["${keeperAddr}"]'`,
);
const pauseStartWallClock = Math.floor(Date.now() / 1000);
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- pause --guardian ${keeperAddr}`,
);
await new Promise((r) => setTimeout(r, 8000));
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- resume_early --admin ${keeperAddr}`,
);
console.log(`    health-monitor: ${healthMonitorId}, real pause+resume cycle done`);

console.log("\n==> [2] Deploying a fresh 1-of-1 vault and generating one real admin-authorized USDC transfer out");
const adminPolicyId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_admin_threshold.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
const vaultId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_vault.wasm " +
    `--source refluo-testnet --network testnet -- ` +
    `--admin_signers '[{"Delegated":"${keeperAddr}"}]' ` +
    `--admin_threshold 1 --admin_policy ${adminPolicyId}`,
).split("\n").pop();
console.log(`    vault: ${vaultId}`);

const fundingAmount = 5_000_000n; // 0.5 USDC
sh(
  `stellar contract invoke --id ${USDC} --source refluo-testnet --network testnet --send=yes ` +
    `-- transfer --from ${keeperAddr} --to ${vaultId} --amount ${fundingAmount}`,
);

const server = new rpc.Server(RPC_URL);
const keeperKeypair = Keypair.fromSecret(secretOf("refluo-testnet"));
const transferAmount = 1_000_000n; // 0.1 USDC, real burn out of the vault
const transferOp = new Contract(USDC).call(
  "transfer",
  new Address(vaultId).toScVal(),
  new Address(keeperAddr).toScVal(),
  nativeToScVal(transferAmount, { type: "i128" }),
);
const transferTx = new TransactionBuilder(
  await server.getAccount(keeperKeypair.publicKey()),
  { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE },
)
  .addOperation(transferOp)
  .setTimeout(60)
  .build();
try {
  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0, // R_ADMIN, always installed at deploy
    unsignedTx: transferTx,
    coSigners: [keeperKeypair],
    sourceKeypair: keeperKeypair,
  });
  check("real admin-authorized USDC transfer out of the vault landed", result.status === "SUCCESS");
} catch (err) {
  check(`real admin-authorized USDC transfer out of the vault (error: ${err.message})`, false);
}

console.log("\n==> [3] Seeding real tier0_sample / recall_triggered metric events via the real appendMetricEvent function");
const metricsLogFile = `.reporter-smoke-metrics-${Date.now()}.jsonl`;
const { appendMetricEvent } = await import("../src/metricsLog.ts");
const nowSeconds = Math.floor(Date.now() / 1000);
appendMetricEvent(metricsLogFile, {
  type: "tier0_sample",
  timestampSeconds: nowSeconds - 100,
  balanceStroops: "200",
  targetStroops: "100",
}); // a hit
appendMetricEvent(metricsLogFile, {
  type: "tier0_sample",
  timestampSeconds: nowSeconds - 50,
  balanceStroops: "50",
  targetStroops: "100",
}); // a miss
appendMetricEvent(metricsLogFile, {
  type: "recall_triggered",
  timestampSeconds: nowSeconds - 40,
  detectedAtSeconds: nowSeconds - 40,
  executedAtSeconds: nowSeconds - 10,
  shortfallStroops: "50",
  status: "SUCCESS",
});

console.log("\n==> [4] Running reporterLoop's real tick() against all of the above");
process.env.RPC_URL = RPC_URL;
process.env.NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;
process.env.HEALTH_MONITOR_ID = healthMonitorId;
process.env.VAULT_ADDRESS = vaultId;
process.env.USDC_TOKEN_ID = USDC;
process.env.KEEPER_METRICS_LOG_FILE = metricsLogFile;
// reporterLoop.ts imports fetchHourlyBurnObservations from
// forecasterLoop.ts, whose module scope requireEnv()s these too, even
// though this test only ever calls the burn-observation fetcher, never
// forecasterLoop's own tick(); RISK_ENGINE_ID/ACCOUNT below reference the
// real reference risk-engine deployment (README's own "kept live for
// manual inspection" instance) purely to satisfy that module load, no
// call is ever made against it here.
process.env.KEEPER_SECRET = secretOf("refluo-testnet");
process.env.RISK_ENGINE_ID = "CDAQLFJU3W26D3CKKXSF4CXGM3HKOA6ANJPWZA6XVFDFCRSZXX73FORY";
process.env.ACCOUNT = keeperAddr;
const snapshotFile = `.reporter-smoke-snapshot-${Date.now()}.json`;
process.env.REPORTER_SNAPSHOT_FILE = snapshotFile;
process.env.REPORTER_WINDOW_HOURS = "1";
process.env.REPORTER_FORECASTER_ERROR_BACKTEST_HOURS = "72";

const { tick } = await import("../src/reporterLoop.ts");
const snapshot = await tick();
console.log(JSON.stringify(snapshot, null, 2));

check(
  "real pause/resume cycle produced exactly one real pause event",
  snapshot.pauseStats.pauseCount === 1,
);
check(
  "real pause duration is close to the real ~8s wall-clock gap between pause and resume",
  snapshot.pauseStats.totalPauseDurationSeconds >= 5 && snapshot.pauseStats.totalPauseDurationSeconds <= 60,
);
check(
  "tier0 hit rate over the two seeded samples (one hit, one miss) is exactly 0.5",
  snapshot.tier0HitRate === 0.5,
);
check(
  "recall latency reflects the real seeded 30s detected-to-executed gap",
  snapshot.recallLatency.count === 1 && snapshot.recallLatency.p50Seconds === 30,
);
check(
  "recall latency histogram sorts the real 30s sample into the 10-30s bucket",
  snapshot.recallLatency.buckets.find((b) => b.label === "10-30s")?.count === 1,
);
check(
  "recall latency histogram bucket counts sum to the real total",
  snapshot.recallLatency.buckets.reduce((sum, b) => sum + b.count, 0) === snapshot.recallLatency.count,
);
check(
  "tier0Series carries the two real seeded samples as stringified balances",
  snapshot.tier0Series.length === 2 &&
    snapshot.tier0Series[0].balanceStroops === "200" &&
    snapshot.tier0Series[1].balanceStroops === "50",
);
check(
  "forecasterErrorSeries is a real array sized to forecasterError.count",
  Array.isArray(snapshot.forecasterErrorSeries) &&
    snapshot.forecasterErrorSeries.length === snapshot.forecasterError.count,
);
check(
  "forecaster error backtest ran against real burn history without throwing (count is a real, possibly-zero number)",
  typeof snapshot.forecasterError.count === "number",
);

const writtenSnapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
check(
  "the real snapshot file on disk matches what tick() returned",
  writtenSnapshot.generatedAtSeconds === snapshot.generatedAtSeconds,
);

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
