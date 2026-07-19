// Swap sentinel: the "XLM auto-swap" half of Phase 3's fee-floor top-up.
// Reads a real XLM balance and a real OracleRouter price, and once the
// balance drops below a configured floor, submits a real, capped,
// oracle-slippage-bounded swap through the real Soroswap router. See
// swapDecision.ts for the pure sizing/floor math this loop calls, and
// adr/0015 for why `ACCOUNT` here is this keeper's own funded identity
// today, not the real `vault` contract: submitting a transaction
// the real `stellar-accounts` CustomAccountInterface vault must itself
// authorize needs the SDK's signing module, the same gap adr/0008 already
// found for the admin multisig case. Everything upstream of that one
// missing piece, balance read, oracle read, sizing, the real router
// quote sanity check, and the real signed submission itself, is real and
// live-verified against this keeper's own funded testnet identity.
import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
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
const ACCOUNT = requireEnv("ACCOUNT");
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

async function tick(): Promise<void> {
  const balanceTx = await xlmToken.balance({ id: ACCOUNT });
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
    `submitting real swap_exact_tokens_for_tokens: amount_in=${need.amountInUsdcStroops} ` +
      `amount_out_min=${need.amountOutMinXlmStroops} to=${ACCOUNT} deadline=${deadline}`,
  );
  const assembled = await router.swap_exact_tokens_for_tokens({
    amount_in: need.amountInUsdcStroops,
    amount_out_min: need.amountOutMinXlmStroops,
    path: [USDC_TOKEN_ID, XLM_TOKEN_ID],
    to: ACCOUNT,
    deadline,
  });
  const sent = await assembled.signAndSend();
  const status = sent.getTransactionResponse?.status ?? "unknown";
  log(`swap submitted, status=${status}`);
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

main().catch((err) => {
  console.error("swap sentinel fatal error:", err);
  process.exit(1);
});
