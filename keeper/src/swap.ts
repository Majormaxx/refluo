// Swap sentinel: the "XLM auto-swap" half of Phase 3's fee-floor top-up.
// Reads the real vault's real XLM balance and a real OracleRouter price,
// and once the balance drops below a configured floor, submits a real,
// capped, oracle-slippage-bounded swap through the real Soroswap router,
// authorized through the real `vault` contract itself (adr/0016). See
// swapDecision.ts for the pure sizing/floor math this loop calls.
//
// The submission is a real `stellar-accounts` `CustomAccountInterface`
// authorization, not a plain EOA transaction: `VAULT_ADDRESS` must have
// an installed context rule (`SWAP_CONTEXT_RULE_ID`) naming this keeper's
// own address as a delegated signer with `policy-swap` attached. That
// single-signer session scope, not a shared admin key, is what bounds
// this loop's blast radius to exactly what policy-swap's own per-call and
// epoch caps allow, same as every other policy-gated keeper action.
import "dotenv/config";
import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { authorizeAndSendSmartAccountCall } from "@refluo/sdk/smartAccountAuth";
import { Client as TokenClient } from "token-client";
import { Client as RouterClient } from "soroswap-router-client";
import { Client as OracleRouterClient } from "oracle-router-client";
import { decideSwap } from "./swapDecision.js";

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
const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");
const SWAP_CONTEXT_RULE_ID = Number(requireEnv("SWAP_CONTEXT_RULE_ID"));
const XLM_TOKEN_ID = requireEnv("XLM_TOKEN_ID");
const USDC_TOKEN_ID = requireEnv("USDC_TOKEN_ID");
const SOROSWAP_ROUTER_ID = requireEnv("SOROSWAP_ROUTER_ID");
const ORACLE_ROUTER_ID = requireEnv("ORACLE_ROUTER_ID");
const ORACLE_ASSET_SYMBOL = process.env.ORACLE_ASSET_SYMBOL ?? "XLM";
const XLM_FLOOR_STROOPS = BigInt(requireEnv("XLM_FLOOR_STROOPS"));
const XLM_TOPUP_TARGET_STROOPS = BigInt(requireEnv("XLM_TOPUP_TARGET_STROOPS"));
const SWAP_MIN_OUT_BPS = Number(process.env.SWAP_MIN_OUT_BPS ?? "9700");
const SWAP_DEADLINE_SECONDS = Number(process.env.SWAP_DEADLINE_SECONDS ?? "60");
const POLL_INTERVAL_SECONDS = Number(process.env.SWAP_POLL_INTERVAL_SECONDS ?? "300");

// OracleStatus::Healthy | OneFeed, mirroring oracle-router's own enum.
const ORACLE_STATUS_HEALTHY = 0;
const ORACLE_STATUS_ONE_FEED = 1;

const keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);
const signer = basicNodeSigner(keeperKeypair, NETWORK_PASSPHRASE);
const server = new rpc.Server(RPC_URL);

const clientOptions = {
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: keeperKeypair.publicKey(),
  ...signer,
};

const xlmToken = new TokenClient({ contractId: XLM_TOKEN_ID, ...clientOptions });
const router = new RouterClient({ contractId: SOROSWAP_ROUTER_ID, ...clientOptions });
const oracle = new OracleRouterClient({ contractId: ORACLE_ROUTER_ID, ...clientOptions });

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// The public testnet RPC load-balances across backend nodes that are
// occasionally a beat behind, intermittently returning a false "not
// found" or a transient 503 for state that demonstrably exists. Retry
// rather than treat a blip as a real error.
async function withRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

export async function tick(): Promise<void> {
  const balanceTx = await xlmToken.balance({ id: VAULT_ADDRESS });
  const xlmBalance = (await balanceTx.simulate()).result;

  const priceTx = await oracle.get_price({
    asset: { tag: "Other", values: [ORACLE_ASSET_SYMBOL] as const },
  });
  const quote = (await priceTx.simulate()).result;

  log(
    `xlm_balance=${xlmBalance} floor=${XLM_FLOOR_STROOPS} ` +
      `oracle_price=${quote.price} oracle_status=${quote.status}`,
  );

  if (quote.status !== ORACLE_STATUS_HEALTHY && quote.status !== ORACLE_STATUS_ONE_FEED) {
    log("oracle degraded, refusing to size a swap against an unreliable price this tick");
    return;
  }

  const need = decideSwap(
    xlmBalance,
    XLM_FLOOR_STROOPS,
    XLM_TOPUP_TARGET_STROOPS,
    quote.price,
    SWAP_MIN_OUT_BPS,
  );
  if (need === null) {
    log("xlm balance at or above floor, no swap needed");
    return;
  }

  log(
    `xlm balance below floor: proposing ${need.amountInUsdcStroops} USDC -> ` +
      `>= ${need.amountOutMinXlmStroops} XLM (oracle-derived floor)`,
  );

  // Real live sanity check before submission: confirm the router's own
  // quote clears the oracle-derived floor against real, current pool
  // reserves, not only our own computed number.
  const routerQuoteTx = await router.router_get_amounts_out({
    amount_in: need.amountInUsdcStroops,
    path: [USDC_TOKEN_ID, XLM_TOKEN_ID],
  });
  const routerQuotedOut = (await routerQuoteTx.simulate()).result.unwrap()[1];
  log(`real Soroswap router quote for this amount_in: ${routerQuotedOut} XLM`);
  if (routerQuotedOut < need.amountOutMinXlmStroops) {
    log(
      "real router quote is below the oracle-derived floor, pool has moved away from " +
        "oracle price or is thin, skipping submission this tick",
    );
    return;
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
  log(
    `submitting real swap_exact_tokens_for_tokens through the vault: ` +
      `amount_in=${need.amountInUsdcStroops} amount_out_min=${need.amountOutMinXlmStroops} ` +
      `to=${VAULT_ADDRESS} deadline=${deadline}`,
  );

  // The vault, not this keeper's own key, is the actual caller: the
  // router pulls USDC from and sends XLM to VAULT_ADDRESS, so the vault
  // itself must authorize this call through its installed SWAP_CONTEXT_RULE_ID
  // rule (policy-swap re-checks the same cap/floor on-chain regardless of
  // what this loop already computed). This keeper's key is that rule's
  // sole delegated signer, a session scope, not the shared admin key.
  const unsignedTx = new TransactionBuilder(
    await withRetry(() => server.getAccount(keeperKeypair.publicKey())),
    { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE },
  )
    .addOperation(
      new Contract(SOROSWAP_ROUTER_ID).call(
        "swap_exact_tokens_for_tokens",
        nativeToScVal(need.amountInUsdcStroops, { type: "i128" }),
        nativeToScVal(need.amountOutMinXlmStroops, { type: "i128" }),
        xdr.ScVal.scvVec([
          new Address(USDC_TOKEN_ID).toScVal(),
          new Address(XLM_TOKEN_ID).toScVal(),
        ]),
        new Address(VAULT_ADDRESS).toScVal(),
        nativeToScVal(deadline, { type: "u64" }),
      ),
    )
    .setTimeout(60)
    .build();

  const result = await authorizeAndSendSmartAccountCall({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    vaultAddress: VAULT_ADDRESS,
    contextRuleId: SWAP_CONTEXT_RULE_ID,
    unsignedTx,
    coSigners: [keeperKeypair],
    sourceKeypair: keeperKeypair,
  });
  log(`swap submitted through the vault, status=${result.status}`);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  log(`swap sentinel starting, polling every ${POLL_INTERVAL_SECONDS}s`);
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] tick failed:`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_SECONDS * 1000));
  }
}

// Only auto-run when executed directly (`tsx src/swap.ts`), not when
// imported as a module (the smoke test imports `tick()` standalone).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("swap sentinel fatal error:", err);
    process.exit(1);
  });
}
