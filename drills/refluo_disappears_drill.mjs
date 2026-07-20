// Live "Refluo disappears" drill (adr/0016), closing the gap adr/0008
// left open: the bootstrap and threshold-enforcement halves were already
// live-verified, but the actual self-rescue action, a real admin 2-of-3
// call through the real vault, was blocked on the SDK's signing module,
// which did not exist. It exists now (sdk/src/smartAccountAuth.ts).
//
// This drill proves the full guarantee end to end against a real, freshly
// deployed vault: a real 2-of-3 call installs a yield policy (the kind of
// setup step a live operator would do), then a second real 2-of-3 call
// removes it, and PolicyVenue's own per-rule storage is confirmed gone
// afterward, not just the vault's rule bookkeeping. Every step here runs
// as a plain local script signing with real keys, no keeper process, no
// dashboard backend, nothing but this script and the raw contract
// addresses, the same zero-off-chain-dependency shape a real operator's
// signing module invocation would have.
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
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { authorizeAndSendSmartAccountCall } from "../sdk/src/smartAccountAuth.js";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: new URL("../", import.meta.url) }).trim();
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

console.log("==> Building vault, policy-admin-threshold, policy-venue");
sh("stellar contract build --package refluo-vault");
sh("stellar contract build --package refluo-policy-admin-threshold");
sh("stellar contract build --package refluo-policy-venue");

console.log("==> Deploying fresh policy-admin-threshold and policy-venue instances");
const adminPolicyId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_admin_threshold.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
const policyVenueId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_venue.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
console.log(`    policy-admin-threshold: ${adminPolicyId}`);
console.log(`    policy-venue: ${policyVenueId}`);

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
console.log(`    vault: ${vaultId}`);

const server = new rpc.Server(RPC_URL);
const sourceKeypair = Keypair.fromSecret(secretOf("refluo-testnet"));
const keypairA = Keypair.fromSecret(secretOf("admin-a"));
const keypairB = Keypair.fromSecret(secretOf("admin-b"));

async function withAccount() {
  return withRetry(() => server.getAccount(sourceKeypair.publicKey()));
}

console.log("\n==> [1] A real 2-of-3 call installs a real yield policy (r_yield)");
const agentKey = Keypair.random();
const venue = Keypair.random().publicKey();
// refluo_common::VenueConfig { venues: Vec<Address>, per_call_cap: i128,
// epoch_cap: i128, epoch_length: u64 } — numeric widths must be explicit,
// nativeToScVal cannot infer i128 vs u32 vs u64 from a bare bigint.
const venueConfig = xdr.ScVal.scvMap(
  [
    ["venues", xdr.ScVal.scvVec([new Address(venue).toScVal()])],
    ["per_call_cap", nativeToScVal(1_000_000n, { type: "i128" })],
    ["epoch_cap", nativeToScVal(5_000_000n, { type: "i128" })],
    ["epoch_length", nativeToScVal(86400n, { type: "u64" })],
  ]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
    ),
);
const policiesMap = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({
    key: new Address(policyVenueId).toScVal(),
    val: venueConfig,
  }),
]);
// ContextRuleType::Default is a unit variant of a mixed enum
// (Default | CallContract(Address) | CreateContract(BytesN<32>));
// soroban_sdk's contracttype derive encodes every variant uniformly as
// Vec[Symbol(name), ...fields], never a bare Symbol, confirmed live: a
// bare Symbol here trapped add_context_rule with UnreachableCodeReached.
const addRuleOp = new Contract(vaultId).call(
  "add_context_rule",
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")]),
  nativeToScVal("r_yield", { type: "string" }),
  nativeToScVal(null, { type: "void" }),
  xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      new Address(agentKey.publicKey()).toScVal(),
    ]),
  ]),
  policiesMap,
);
const addRuleTx = new TransactionBuilder(await withAccount(), {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(addRuleOp)
  .setTimeout(60)
  .build();
try {
  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0,
    unsignedTx: addRuleTx,
    coSigners: [keypairA, keypairB],
    sourceKeypair,
  });
  check("real 2-of-3 call installed r_yield with policy-venue attached", result.status === "SUCCESS");
} catch (err) {
  check(`real 2-of-3 call installed r_yield (error: ${err.message})`, false);
}

console.log("\n==> [2] Confirm the policy is really installed before the rescue");
const rulesBefore = JSON.parse(
  sh(
    `stellar contract invoke --id ${vaultId} --source refluo-testnet --network testnet -- get_context_rules_count`,
  ),
);
check("vault has 2 context rules before rescue (R_ADMIN + r_yield)", rulesBefore === 2);
const venueConfigBefore = sh(
  `stellar contract invoke --id ${policyVenueId} --source refluo-testnet --network testnet -- config --smart_account ${vaultId} --context_rule_id 1`,
);
check("policy-venue's own storage for (vault, rule 1) exists before rescue", venueConfigBefore.includes(venue));

console.log("\n==> [3] The real rescue: a real 2-of-3 call removes r_yield entirely");
const removeRuleOp = new Contract(vaultId).call(
  "remove_context_rule",
  nativeToScVal(1, { type: "u32" }),
);
const removeRuleTx = new TransactionBuilder(await withAccount(), {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(removeRuleOp)
  .setTimeout(60)
  .build();
try {
  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: vaultId,
    contextRuleId: 0,
    unsignedTx: removeRuleTx,
    coSigners: [keypairA, keypairB],
    sourceKeypair,
  });
  check("real 2-of-3 rescue call removed r_yield and landed on-chain", result.status === "SUCCESS");
} catch (err) {
  check(`real 2-of-3 rescue call removed r_yield (error: ${err.message})`, false);
}

console.log("\n==> [4] Confirm the rescue really happened: rule gone AND policy's own storage gone");
const rulesAfter = JSON.parse(
  sh(
    `stellar contract invoke --id ${vaultId} --source refluo-testnet --network testnet -- get_context_rules_count`,
  ),
);
check("vault back down to 1 context rule (only R_ADMIN survives)", rulesAfter === 1);

let venueConfigAfterFailed = false;
try {
  sh(
    `stellar contract invoke --id ${policyVenueId} --source refluo-testnet --network testnet -- config --smart_account ${vaultId} --context_rule_id 1`,
  );
} catch {
  venueConfigAfterFailed = true;
}
check(
  "policy-venue's own per-rule storage is really gone, not just the vault's rule bookkeeping (NotInitialized)",
  venueConfigAfterFailed,
);

console.log(`\n==> ${pass} passed, ${fail} failed`);
console.log(
  "\nEverything above ran as a plain local script signing with real admin keys: no keeper\n" +
    "process, no dashboard backend, nothing but this script and the vault's own raw contract\n" +
    "address. That is the self-rescue guarantee, demonstrated, not asserted.",
);
if (fail > 0) {
  process.exit(1);
}
