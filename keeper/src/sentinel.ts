// Sentinel loop: the "utilization monitor" Phase 3 of the internal
// roadmap names. Reads a real Blend V2 pool's real reserve utilization
// via @blend-capital/blend-sdk (the official SDK, not a hand-rolled RPC
// call), and when it crosses RiskEngine's own configured thresholds,
// attests it on-chain via a real keeper_advance_state call. See
// decision.ts for why this is an escalation-only loop.
import "dotenv/config";
import { PoolV2 } from "@blend-capital/blend-sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as RiskEngineClient, SystemState } from "risk-engine-client";
import { toBps, decideEscalation } from "./decision.js";

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
const BLEND_POOL_ID = requireEnv("BLEND_POOL_ID");
const RESERVE_ASSET_ID = requireEnv("RESERVE_ASSET_ID");
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS ?? "60");

const keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);
const signer = basicNodeSigner(keeperKeypair, NETWORK_PASSPHRASE);

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

async function tick(): Promise<void> {
  const pool = await PoolV2.load(
    { rpc: RPC_URL, passphrase: NETWORK_PASSPHRASE },
    BLEND_POOL_ID,
  );
  const reserve = pool.reserves.get(RESERVE_ASSET_ID);
  if (!reserve) {
    throw new Error(
      `reserve ${RESERVE_ASSET_ID} not found in pool ${BLEND_POOL_ID}; check RESERVE_ASSET_ID`,
    );
  }
  const utilizationBps = toBps(reserve.getUtilization());

  const cfgTx = await riskEngine.config({ account: ACCOUNT });
  const cfg = (await cfgTx.simulate()).result;
  const stateTx = await riskEngine.state({ account: ACCOUNT });
  const currentState = (await stateTx.simulate()).result;

  log(
    `utilization=${utilizationBps}bps state=${SystemState[currentState]} ` +
      `preemptive_util_bps=${cfg.preemptive_util_bps} full_drain_util_bps=${cfg.full_drain_util_bps}`,
  );

  const target = decideEscalation(
    utilizationBps,
    currentState,
    cfg.preemptive_util_bps,
    cfg.full_drain_util_bps,
  );
  if (target === null) {
    log("no escalation needed");
    return;
  }

  log(`attesting utilization to move ${SystemState[currentState]} -> ${SystemState[target]}`);
  const assembled = await riskEngine.keeper_advance_state({
    account: ACCOUNT,
    keeper: keeperKeypair.publicKey(),
    to: target,
    utilization_bps: utilizationBps,
  });
  const sent = await assembled.signAndSend();
  const status = sent.getTransactionResponse?.status ?? "unknown";
  log(`keeper_advance_state submitted, status=${status}`);
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  if (once) {
    await tick();
    return;
  }
  log(`sentinel starting, polling every ${POLL_INTERVAL_SECONDS}s`);
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
  console.error("sentinel fatal error:", err);
  process.exit(1);
});
