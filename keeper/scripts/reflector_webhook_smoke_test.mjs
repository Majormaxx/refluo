// Live end-to-end verification of the Reflector Subscriptions webhook
// pipeline (adr/0018), everything real except the actual POST's origin:
// no real testnet deployment of Reflector's Subscriptions contract was
// discoverable (exhaustively searched, see reflectorSubscriptionManager.ts's
// header comment), so this can't wait for a real Reflector node to push a
// notification. Everything downstream of "an HTTP POST with a
// Reflector-shaped body arrived" is real and live-verified here:
//   - a real deployed HealthMonitor, this keeper's key as a real
//     registered guardian
//   - a real HTTP server (reflectorWebhookServer.ts), not a mock
//   - real Ed25519 signature verification against the real
//     canonicalization scheme (throwaway keypairs standing in for real
//     Reflector node keys, configured as this run's trusted verifiers)
//   - real quorum accumulation across distinct verifier keys
//   - a real live fetch against RedStone's real REST API
//   - a real on-chain HealthMonitor.pause() call once cross-check fails,
//     confirmed by a real status() read before and after
import { execSync } from "node:child_process";
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";

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

console.log("==> Building health-monitor");
sh("stellar contract build --package refluo-health-monitor");

console.log("==> Deploying a fresh HealthMonitor, this keeper as its sole guardian");
const keeperAddr = addressOf("refluo-testnet");
const healthMonitorId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet --send=yes ` +
    `-- init_guardians --admin ${keeperAddr} --guardians '["${keeperAddr}"]'`,
);
console.log(`    health-monitor: ${healthMonitorId}`);

const statusBefore = sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet -- status`,
);
check("real HealthMonitor starts unpaused", statusBefore === "false");

console.log("\n==> [1] Fetching a real live RedStone XLM price to construct a guaranteed-divergent update");
const redstoneResponse = await fetch("https://api.redstone.finance/prices?symbol=XLM");
const redstoneBody = await redstoneResponse.json();
const realRedstonePrice = redstoneBody[0].value;
check("real RedStone REST endpoint returned a live XLM price", typeof realRedstonePrice === "number" && realRedstonePrice > 0);
console.log(`    live RedStone XLM price: $${realRedstonePrice}`);

// A price 10x the real one: guaranteed to exceed any sane divergence
// band, so cross-check must decide to pause.
const decimals = 14;
const divergentPriceRaw = (BigInt(Math.round(realRedstonePrice * 10 * 10 ** decimals))).toString();

function sortObjectKeys(value) {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const sorted = {};
  for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = sortObjectKeys(value[key]);
  }
  return sorted;
}
function computeUpdateHash(update) {
  const canonical = JSON.stringify(sortObjectKeys(update));
  return createHash("sha256").update(Buffer.from(canonical)).digest();
}

const event = {
  subscription: "1",
  base: { source: "pubnet", asset: "XLM" },
  quote: { source: "exchanges", asset: "USD" },
  decimals,
  price: divergentPriceRaw,
  prevPrice: divergentPriceRaw,
  timestamp: Date.now(),
};

console.log("\n==> [2] Starting the real webhook server with two throwaway keys as trusted verifiers");
const nodeA = Keypair.random();
const nodeB = Keypair.random();
const port = 8799;
process.env.RPC_URL = RPC_URL;
process.env.NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;
process.env.KEEPER_SECRET = secretOf("refluo-testnet");
process.env.HEALTH_MONITOR_ID = healthMonitorId;
process.env.REFLECTOR_TRUSTED_VERIFIERS = `${nodeA.publicKey()},${nodeB.publicKey()}`;
process.env.REFLECTOR_QUORUM_SIZE = "2";
process.env.REFLECTOR_DIVERGENCE_HARD_BPS = "500";
process.env.REFLECTOR_REDSTONE_SYMBOL = "XLM";
process.env.REFLECTOR_WEBHOOK_PORT = String(port);

const { createReflectorWebhookServer } = await import("../src/reflectorWebhookServer.ts");
const server = createReflectorWebhookServer();
await new Promise((resolve) => server.listen(port, resolve));
console.log(`    real HTTP server listening on :${port}`);

function notificationFrom(nodeKeypair, evt) {
  const hash = computeUpdateHash(evt);
  return {
    update: { contract: healthMonitorId, events: [], event: evt, root: "" },
    signature: nodeKeypair.sign(hash).toString("base64"),
    verifier: nodeKeypair.publicKey(),
  };
}

async function post(body) {
  const res = await fetch(`http://127.0.0.1:${port}/reflector-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

console.log("\n==> [3] POSTing the first real signed notification (below quorum)");
const first = await post(notificationFrom(nodeA, event));
check("first notification recorded but does not yet reach quorum", first.body.status === "recorded");

console.log("\n==> [4] POSTing an untrusted verifier's notification (must be rejected)");
const impostor = Keypair.random();
const rejected = await post(notificationFrom(impostor, event));
check(
  "notification from an untrusted verifier is rejected",
  rejected.body.status === "rejected-untrusted-verifier",
);

console.log("\n==> [5] POSTing the second real signed notification: quorum reached, real cross-check, real pause");
const second = await post(notificationFrom(nodeB, event));
check("second confirmation reaches real quorum", second.body.status === "quorum-reached");

// The pause call is fired async inside the handler before responding;
// give the real on-chain transaction time to land.
await new Promise((r) => setTimeout(r, 15000));

const statusAfter = sh(
  `stellar contract invoke --id ${healthMonitorId} --source refluo-testnet --network testnet -- status`,
);
check(
  "a real 10x price divergence, confirmed by real quorum, triggered a real on-chain guardian pause",
  statusAfter === "true",
);

server.close();

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
