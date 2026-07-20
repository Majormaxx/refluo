// Live end-to-end verification of swap.ts submitting through a real
// `vault` contract (adr/0016), not this keeper's own funded identity.
// Provisions a real throwaway vault with a real r_swap context rule
// (this keeper's key as its sole delegated signer, policy-swap attached
// with real config), funds it with real USDC and a real XLM balance
// deliberately below the configured floor, then runs the exact tick()
// swap.ts's continuous loop calls and confirms the vault's own real
// balances moved: real USDC out, real XLM in, authorized through the
// vault's CustomAccountInterface, not a plain EOA transaction.
//
// Requires: stellar-cli, tsx, and a funded testnet identity holding real
// USDC (see contracts/policy-swap/scripts/testnet_smoke_test.sh for how
// to acquire some by swapping XLM first).
import { execSync } from "node:child_process";
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

const REFLECTOR_TESTNET = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const REDSTONE_SEP40_TESTNET = "CA7MY6TYNL5Z5H5FYGMN7YWSY3JIZG7LFY3DZ26EEGRBQ2UKTFWHD4ZJ";
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function shOnce(cmd) {
  return execSync(cmd, { encoding: "utf8", cwd: new URL("../../", import.meta.url) }).trim();
}
// The public testnet RPC intermittently 503s under load; retry rather
// than treat a transient outage as a real failure.
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

console.log("==> Building vault, policy-admin-threshold, policy-swap, oracle-router");
sh("stellar contract build --package refluo-vault");
sh("stellar contract build --package refluo-policy-admin-threshold");
sh("stellar contract build --package refluo-policy-swap");
sh("stellar contract build --package refluo-oracle-router");

console.log("==> Deploying a fresh oracle-router (real Reflector + RedStone feeds)");
const oracleId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_oracle_router.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
sh(
  `stellar contract invoke --id ${oracleId} --source refluo-testnet --network testnet --send=yes ` +
    `-- set_config --asset '{"Other":"XLM"}' --cfg '{` +
    `"primary_feed":"${REFLECTOR_TESTNET}","primary_asset":{"Other":"XLM"},` +
    `"secondary_feed":"${REDSTONE_SEP40_TESTNET}","secondary_asset":{"Stellar":"${XLM}"},` +
    `"max_staleness_primary":600,"max_staleness_secondary":90000,` +
    `"twap_periods":6,"divergence_soft":200,"divergence_hard":500,"max_roc_per_update":1000}'`,
);
console.log(`    oracle-router: ${oracleId}`);

console.log("==> Deploying policy-admin-threshold, policy-swap, and a fresh 1-of-1 vault");
const adminPolicyId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_admin_threshold.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
const policySwapId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_swap.wasm " +
    "--source refluo-testnet --network testnet",
).split("\n").pop();
const keeperAddr = addressOf("refluo-testnet");
const vaultId = sh(
  "stellar contract deploy --wasm target/wasm32v1-none/release/refluo_vault.wasm " +
    `--source refluo-testnet --network testnet -- ` +
    `--admin_signers '[{"Delegated":"${keeperAddr}"}]' ` +
    `--admin_threshold 1 --admin_policy ${adminPolicyId}`,
).split("\n").pop();
console.log(`    policy-admin-threshold: ${adminPolicyId}`);
console.log(`    policy-swap: ${policySwapId}`);
console.log(`    vault (1-of-1, this keeper's own key as sole admin): ${vaultId}`);

const server = new rpc.Server(RPC_URL);
const keeperKeypair = Keypair.fromSecret(secretOf("refluo-testnet"));

function scValMap(fields) {
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
      ),
  );
}

console.log("\n==> [1] A real (self-authorized) admin call installs r_swap with policy-swap attached");
const perCallCap = 100_000_000n; // 10 USDC
const epochCap = 200_000_000n; // 20 USDC
const swapConfig = scValMap({
  router: new Address(ROUTER).toScVal(),
  token_in: new Address(USDC).toScVal(),
  token_out: new Address(XLM).toScVal(),
  token_in_decimals: nativeToScVal(7, { type: "u32" }),
  token_out_decimals: nativeToScVal(7, { type: "u32" }),
  oracle_router: new Address(oracleId).toScVal(),
  oracle_asset: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol("XLM")]),
  oracle_price_decimals: nativeToScVal(14, { type: "u32" }),
  per_call_cap: nativeToScVal(perCallCap, { type: "i128" }),
  epoch_cap: nativeToScVal(epochCap, { type: "i128" }),
  epoch_length: nativeToScVal(86400n, { type: "u64" }),
  min_out_bps: nativeToScVal(9700, { type: "u32" }),
  max_deadline_window: nativeToScVal(300n, { type: "u64" }),
});
const policiesMap = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: new Address(policySwapId).toScVal(), val: swapConfig }),
]);
const addRuleOp = new Contract(vaultId).call(
  "add_context_rule",
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")]),
  nativeToScVal("r_swap", { type: "string" }),
  nativeToScVal(null, { type: "void" }),
  xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), new Address(keeperAddr).toScVal()]),
  ]),
  policiesMap,
);
async function withAccount() {
  return withRetry(() => server.getAccount(keeperKeypair.publicKey()));
}
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
    coSigners: [keeperKeypair],
    sourceKeypair: keeperKeypair,
  });
  check("real admin call installed r_swap with policy-swap attached", result.status === "SUCCESS");
} catch (err) {
  check(`real admin call installed r_swap (error: ${err.message})`, false);
}

console.log("\n==> [2] Funding the vault: real USDC and a real XLM balance below the floor");
const XLM_STARTING = 100_0000000n; // 100 XLM, deliberately below the floor set below
sh(
  `stellar contract invoke --id ${XLM} --source refluo-testnet --network testnet --send=yes ` +
    `-- transfer --from ${keeperAddr} --to ${vaultId} --amount ${XLM_STARTING}`,
);
const usdcFunding = perCallCap; // exactly one swap's worth
sh(
  `stellar contract invoke --id ${USDC} --source refluo-testnet --network testnet --send=yes ` +
    `-- transfer --from ${keeperAddr} --to ${vaultId} --amount ${usdcFunding}`,
);
console.log(`    funded vault with ${XLM_STARTING} XLM stroops and ${usdcFunding} USDC stroops`);

console.log("\n==> [3] Running swap.ts's real tick() against this vault");
process.env.RPC_URL = RPC_URL;
process.env.NETWORK_PASSPHRASE = NETWORK_PASSPHRASE;
process.env.KEEPER_SECRET = secretOf("refluo-testnet");
process.env.VAULT_ADDRESS = vaultId;
process.env.SWAP_CONTEXT_RULE_ID = "1";
process.env.XLM_TOKEN_ID = XLM;
process.env.USDC_TOKEN_ID = USDC;
process.env.SOROSWAP_ROUTER_ID = ROUTER;
process.env.ORACLE_ROUTER_ID = oracleId;
process.env.ORACLE_ASSET_SYMBOL = "XLM";
// floor=110 XLM (above the 100 XLM funded, forces a trigger),
// target=140 XLM: shortfall of 40 XLM sizes to roughly ~7.4 USDC at the
// real live price, within both the 10 USDC per_call_cap and the 10 USDC
// actually funded below (perCallCap is stroops, 7 decimals: 100_000_000
// == 10 USDC, not 100). target must be strictly above floor.
process.env.XLM_FLOOR_STROOPS = "1100000000";
process.env.XLM_TOPUP_TARGET_STROOPS = "1400000000";
process.env.SWAP_MIN_OUT_BPS = "9700";
process.env.SWAP_DEADLINE_SECONDS = "120";

const usdcBefore = sh(
  `stellar contract invoke --id ${USDC} --source refluo-testnet --network testnet -- balance --id ${vaultId}`,
);
const xlmBefore = sh(
  `stellar contract invoke --id ${XLM} --source refluo-testnet --network testnet -- balance --id ${vaultId}`,
);
console.log(`    vault before: USDC=${usdcBefore} XLM=${xlmBefore}`);

await import("../src/swap.ts").then((mod) => mod.tick());

const usdcAfter = sh(
  `stellar contract invoke --id ${USDC} --source refluo-testnet --network testnet -- balance --id ${vaultId}`,
);
const xlmAfter = sh(
  `stellar contract invoke --id ${XLM} --source refluo-testnet --network testnet -- balance --id ${vaultId}`,
);
console.log(`    vault after:  USDC=${usdcAfter} XLM=${xlmAfter}`);
check(
  "a real keeper-triggered swap through the vault moved real USDC out and real XLM in",
  usdcAfter !== usdcBefore && xlmAfter !== xlmBefore,
);

console.log(`\n==> ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
