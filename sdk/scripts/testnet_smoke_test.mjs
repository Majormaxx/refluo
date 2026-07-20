// Live end-to-end verification of the SDK's signing module against a
// real, freshly deployed 2-of-3 vault (adr/0016), not a calldata-shape
// assumption or an in-process test. Three real halves: a real 2-of-3
// call authorizes and lands on-chain, a real 1-of-3 attempt is rejected
// by the real threshold policy, and a real 3-of-3 call (every admin
// co-signing, beyond the 2-of-3 minimum) still succeeds.
//
// Requires: stellar-cli, tsx, and four funded testnet identities (the
// fee-paying source plus three admins). Create them with:
//   stellar keys generate refluo-testnet --network testnet --fund
//   stellar keys generate admin-a --network testnet --fund
//   stellar keys generate admin-b --network testnet --fund
//   stellar keys generate admin-c --network testnet --fund
import { execSync } from "node:child_process";
import {
  Keypair,
  Networks,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { authorizeAndSendSmartAccountCall } from "../src/smartAccountAuth.js";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: new URL("../../", import.meta.url) }).trim();
}

function secretOf(identity) {
  return sh(`stellar keys show ${identity}`);
}

function addressOf(identity) {
  return sh(`stellar keys address ${identity}`);
}

async function withRetry(fn, attempts = 5, delayMs = 1500) {
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

console.log("==> Building vault and policy-admin-threshold");
sh("stellar contract build --package refluo-vault");
sh("stellar contract build --package refluo-policy-admin-threshold");

console.log("==> Deploying a fresh policy-admin-threshold instance");
const adminPolicyId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_admin_threshold.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
console.log(`    deployed at ${adminPolicyId}`);

console.log("==> Deploying a fresh 2-of-3 vault (admin-a, admin-b, admin-c)");
const adminA = addressOf("admin-a");
const adminB = addressOf("admin-b");
const adminC = addressOf("admin-c");
const vaultId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_vault.wasm " +
    `--source refluo-testnet --network testnet -- ` +
    `--admin_signers '[{"Delegated":"${adminA}"},{"Delegated":"${adminB}"},{"Delegated":"${adminC}"}]' ` +
    `--admin_threshold 2 --admin_policy ${adminPolicyId}`,
).split("\n").pop();
console.log(`    deployed at ${vaultId}`);

const server = new rpc.Server(RPC_URL);
const sourceKeypair = Keypair.fromSecret(secretOf("refluo-testnet"));
const keypairA = Keypair.fromSecret(secretOf("admin-a"));
const keypairB = Keypair.fromSecret(secretOf("admin-b"));
const keypairC = Keypair.fromSecret(secretOf("admin-c"));

async function buildRenameTx(name) {
  const account = await withRetry(() => server.getAccount(sourceKeypair.publicKey()));
  const op = new Contract(vaultId).call(
    "update_context_rule_name",
    nativeToScVal(0, { type: "u32" }),
    nativeToScVal(name, { type: "string" }),
  );
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
}

console.log("\n==> [1] A real 2-of-3 call (admin-a, admin-b) must authorize and land on-chain");
try {
  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0,
    unsignedTx: await buildRenameTx("R_ADMIN"),
    coSigners: [keypairA, keypairB],
    sourceKeypair,
  });
  check("real 2-of-3 call authorized and landed on-chain", result.status === "SUCCESS");
} catch (err) {
  check(`real 2-of-3 call authorized and landed on-chain (error: ${err.message})`, false);
}

console.log("\n==> [2] A real 1-of-3 attempt (admin-a alone) must be rejected by the real threshold");
try {
  await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0,
    unsignedTx: await buildRenameTx("R_ADMIN"),
    coSigners: [keypairA],
    sourceKeypair,
  });
  check("1-of-3 rejected by the real threshold policy", false);
} catch (err) {
  check(
    `1-of-3 rejected by the real threshold policy (${err.message.includes("InvalidAction") ? "real on-chain Auth error" : "unexpected error shape"})`,
    err.message.includes("InvalidAction") || err.message.includes("simulation failed"),
  );
}

console.log("\n==> [3] A real 3-of-3 call (every admin co-signing) must also succeed");
try {
  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0,
    unsignedTx: await buildRenameTx("R_ADMIN"),
    coSigners: [keypairA, keypairB, keypairC],
    sourceKeypair,
  });
  check("real 3-of-3 call (beyond the 2-of-3 minimum) authorized and landed", result.status === "SUCCESS");
} catch (err) {
  check(`real 3-of-3 call authorized and landed (error: ${err.message})`, false);
}

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
