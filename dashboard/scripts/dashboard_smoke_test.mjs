// Live end-to-end verification of the dashboard's real server-side logic
// against real deployed contracts, running against `next start` (a real
// production build, not `next dev`). Every write action a real operator
// would sign through Freighter in the browser is instead signed here
// with a plain Keypair using the exact same `signTransaction` callback
// shape the generated *-client packages expect (documented as "matches
// signature of signTransaction from Freighter") — this substitutes the
// wallet's UI for a real Ed25519 keypair, not the underlying contract
// interaction, which is unchanged and fully real. No visual/interactive
// browser+extension verification was performed in this pass (disclosed
// in adr/0021): that would need a real Freighter-equipped browser this
// sandboxed environment doesn't have.
import { Keypair } from "@stellar/stellar-sdk";
import { Client as HealthMonitorClient } from "dashboard-health-monitor-client";
import { Client as TimelockClient } from "dashboard-timelock-client";

const BASE_URL = process.env.DASHBOARD_URL ?? "http://127.0.0.1:4173";
const RPC_URL = process.env.RPC_URL;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE;
const HEALTH_MONITOR_ID = process.env.HEALTH_MONITOR_ID;
const TIMELOCK_ID = process.env.TIMELOCK_ID;
const KEEPER_SECRET = process.env.KEEPER_SECRET;

const keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);

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

// The public testnet RPC (reached both directly and via this dashboard's
// own server-side routes) intermittently times out under load; retry
// rather than treat a transient blip as a real failure, the same pattern
// every other live script in this workspace already uses.
const realFetch = globalThis.fetch;
async function fetchWithRetry(url, opts, attempts = 5, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await realFetch(url, opts);
      if (res.status >= 500 && i < attempts - 1) {
        lastErr = new Error(`server error ${res.status}`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
const fetch = fetchWithRetry;

async function retryAsync(fn, attempts = 5, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

function extractCookie(res, name) {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")].filter(Boolean);
  for (const c of raw) {
    if (c.startsWith(`${name}=`)) {
      return c.split(";")[0];
    }
  }
  return null;
}

async function signInAs(address, keypair) {
  const challengeRes = await fetch(`${BASE_URL}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const { nonce, message } = await challengeRes.json();

  // The exact real SEP-53 scheme challenge.ts implements: prefix the
  // message, sha256, Ed25519-sign — a real signature over the real
  // preimage, from a real keypair, not a mock.
  const { hash } = await import("@stellar/stellar-sdk");
  const signature = keypair.sign(
    hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), Buffer.from(message, "utf8")])),
  );

  const verifyRes = await fetch(`${BASE_URL}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, address, signedMessage: signature.toString("base64") }),
  });
  const cookie = extractCookie(verifyRes, "refluo_session");
  const body = await verifyRes.json();
  return { ok: verifyRes.ok, cookie, body };
}

console.log("==> [1] Real sign-in as the real vault admin / health-monitor guardian");
const KEEPER_ADDR = keeperKeypair.publicKey();
const signIn = await signInAs(KEEPER_ADDR, keeperKeypair);
check("real SEP-53 challenge/verify sign-in succeeds for the real admin address", signIn.ok);
check("resolved role is admin (this address is the vault's real R_ADMIN delegated signer)", signIn.body.role === "admin");
const cookie = signIn.cookie;

console.log("\n==> [2] Rejecting sign-in for an address with no real standing");
const outsiderKeypair = Keypair.random();
const outsiderSignIn = await signInAs(outsiderKeypair.publicKey(), outsiderKeypair);
check("an address that is neither a real admin nor guardian is rejected", !outsiderSignIn.ok);

console.log("\n==> [3] Real vault overview read (authenticated)");
const overviewRes = await fetch(`${BASE_URL}/api/vault/overview`, { headers: { cookie } });
const overview = await overviewRes.json();
check("vault overview request succeeds with a real session", overviewRes.ok);
check("real system state is Normal for a freshly initialized risk-engine", overview.systemState === "Normal");
check("real context rules include the R_ADMIN rule this admin signed in through", overview.contextRules.some((r) => r.delegatedSigners.includes(KEEPER_ADDR)));

console.log("\n==> [4] Real vault overview read rejected without a session");
const unauthOverview = await fetch(`${BASE_URL}/api/vault/overview`);
check("vault overview request is rejected with no session cookie", unauthOverview.status === 401);

console.log("\n==> [5] Real guardian/pause panel read, then a real guardian pause via the same client code the browser action uses");
const statusBefore = await (await fetch(`${BASE_URL}/api/health-monitor/status`, { headers: { cookie } })).json();
check("real guardian roster includes the signed-in address", statusBefore.guardians.includes(KEEPER_ADDR));
check("health-monitor starts unpaused", statusBefore.paused === false);

const healthMonitorClient = new HealthMonitorClient({
  contractId: HEALTH_MONITOR_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: KEEPER_ADDR,
  signTransaction: async (xdrString, opts) => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(xdrString, opts.networkPassphrase);
    tx.sign(keeperKeypair);
    return { signedTxXdr: tx.toEnvelope().toXDR("base64") };
  },
});
const pauseAssembled = await retryAsync(() => healthMonitorClient.pause({ guardian: KEEPER_ADDR }));
const pauseSent = await retryAsync(() => pauseAssembled.signAndSend());
check("real pause transaction, built by the same client dashboard actions use, lands with SUCCESS", pauseSent.getTransactionResponse?.status === "SUCCESS");

const statusAfter = await (await fetch(`${BASE_URL}/api/health-monitor/status`, { headers: { cookie } })).json();
check("dashboard's real read reflects the real on-chain pause", statusAfter.paused === true);
check("dashboard's real read shows a real pause_expiry decoded from the real emitted event", typeof statusAfter.pauseExpirySeconds === "number" && statusAfter.pauseExpirySeconds > 0);

console.log("\n==> [6] Real timelock queue read (no auth required), then a real cancel");
const proposalsBefore = await (await fetch(`${BASE_URL}/api/timelock/proposals`)).json();
check("real pending proposal (id 0, proposed earlier) appears in the watcher-transparent queue", proposalsBefore.proposals.some((p) => p.id === "0"));

const timelockClient = new TimelockClient({
  contractId: TIMELOCK_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: KEEPER_ADDR,
  signTransaction: async (xdrString, opts) => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(xdrString, opts.networkPassphrase);
    tx.sign(keeperKeypair);
    return { signedTxXdr: tx.toEnvelope().toXDR("base64") };
  },
});
const cancelAssembled = await retryAsync(() => timelockClient.cancel({ id: 0n, admin: KEEPER_ADDR }));
const cancelSent = await retryAsync(() => cancelAssembled.signAndSend());
check("real cancel transaction lands with SUCCESS", cancelSent.getTransactionResponse?.status === "SUCCESS");

const proposalsAfter = await (await fetch(`${BASE_URL}/api/timelock/proposals`)).json();
check("the real cancelled proposal no longer appears in the pending queue", !proposalsAfter.proposals.some((p) => p.id === "0"));

console.log("\n==> [7] Real alerts config round-trip (admin-only)");
const alertsPutRes = await fetch(`${BASE_URL}/api/alerts`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ webhookUrl: "https://example.com/hook", slackUrl: "", discordUrl: "", pagerdutyRoutingKey: "" }),
});
check("admin can write alerts config", alertsPutRes.ok);
const alertsGetRes = await (await fetch(`${BASE_URL}/api/alerts`, { headers: { cookie } })).json();
check("the real written config round-trips from the real local file", alertsGetRes.webhookUrl === "https://example.com/hook");

const alertsUnauthRes = await fetch(`${BASE_URL}/api/alerts`);
check("alerts config is rejected without an admin session", alertsUnauthRes.status === 401);

console.log("\n==> [8] Real sign-out clears the session");
const signOutRes = await fetch(`${BASE_URL}/api/auth/session`, { method: "DELETE", headers: { cookie } });
check("sign-out succeeds", signOutRes.ok);
const sessionAfterSignOut = await (await fetch(`${BASE_URL}/api/auth/session`, { headers: { cookie: extractCookie(signOutRes, "refluo_session") ?? cookie } })).json();
check("session reports unauthenticated once the cleared cookie is sent back", sessionAfterSignOut.authenticated === false);

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
