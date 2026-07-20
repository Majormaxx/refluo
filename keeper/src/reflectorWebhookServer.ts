// Real HTTP receiver for Reflector Subscriptions push notifications
// (adr/0018): verifies each POST's real Ed25519 signature
// (reflectorSubscription.ts), accumulates a real quorum of distinct
// trusted verifier confirmations for the same price update
// (reflectorQuorum.ts), then cross-checks the confirmed price against a
// real RedStone REST quote before ever pausing anything
// (implementation-spec §9's sentinel-loop design). A guardian pause is a
// blunt, wide instrument (health-monitor's own doc comment: "false
// positives only block risk-increasing actions"), so this only fires
// once BOTH a real signed quorum and a real independent second source
// agree something is wrong, never on a single node's say-so and never on
// Reflector's number alone.
//
// The pause call itself needs no smart-account auth: HealthMonitor.pause
// takes a guardian's own require_auth() directly (confirmed from
// contracts/health-monitor/src/lib.rs), so KEEPER_SECRET signs as itself
// provided it's already in the deployed HealthMonitor's own guardian set
// (`init_guardians`).
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Keypair } from "@stellar/stellar-sdk";
import { Client as HealthMonitorClient } from "health-monitor-client";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { QuorumTracker } from "./reflectorQuorum.js";
import { crossCheckPrice, fetchRedStonePriceUsd, type ReflectorNotification } from "./reflectorSubscription.js";

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
const HEALTH_MONITOR_ID = requireEnv("HEALTH_MONITOR_ID");
const TRUSTED_VERIFIERS = requireEnv("REFLECTOR_TRUSTED_VERIFIERS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const QUORUM_SIZE = Number(process.env.REFLECTOR_QUORUM_SIZE ?? "2");
const QUORUM_WINDOW_SECONDS = Number(process.env.REFLECTOR_QUORUM_WINDOW_SECONDS ?? "600");
const DIVERGENCE_HARD_BPS = Number(process.env.REFLECTOR_DIVERGENCE_HARD_BPS ?? "500");
const REDSTONE_SYMBOL = process.env.REFLECTOR_REDSTONE_SYMBOL ?? "XLM";
const PORT = Number(process.env.REFLECTOR_WEBHOOK_PORT ?? "8787");
const PATH = process.env.REFLECTOR_WEBHOOK_PATH ?? "/reflector-webhook";
const MAX_BODY_BYTES = 65536;

const keeperKeypair = Keypair.fromSecret(KEEPER_SECRET);
const signer = basicNodeSigner(keeperKeypair, NETWORK_PASSPHRASE);
const healthMonitor = new HealthMonitorClient({
  contractId: HEALTH_MONITOR_ID,
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  publicKey: keeperKeypair.publicKey(),
  ...signer,
});

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export const tracker = new QuorumTracker(TRUSTED_VERIFIERS, QUORUM_SIZE, QUORUM_WINDOW_SECONDS);

/** Reads and JSON-parses a request body, capped so an unbounded POST
 * can't exhaust memory before signature verification ever runs. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isReflectorNotification(value: unknown): value is ReflectorNotification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.signature !== "string" || typeof v.verifier !== "string") return false;
  const update = v.update as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object") return false;
  const event = update.event as Record<string, unknown> | undefined;
  return (
    !!event &&
    typeof event.price === "string" &&
    typeof event.decimals === "number" &&
    typeof event.timestamp === "number"
  );
}

/** Triggers a real on-chain guardian pause. Exported so a live smoke
 * test can invoke it directly against a real deployed HealthMonitor
 * without needing an actual quorum of real Reflector signatures first. */
export async function triggerGuardianPause(): Promise<string> {
  log("triggering real HealthMonitor.pause via guardian auth");
  const assembled = await healthMonitor.pause({ guardian: keeperKeypair.publicKey() });
  const sent = await assembled.signAndSend();
  const status = sent.getTransactionResponse?.status ?? "unknown";
  log(`HealthMonitor.pause submitted, status=${status}`);
  return status;
}

/** Handles one confirmed (real quorum-reached) price update: cross-checks
 * against RedStone and pauses if they diverge beyond the hard band.
 * Exported for direct testing against synthetic but correctly-shaped
 * events without going through the HTTP layer. */
export async function handleConfirmedUpdate(
  event: ReflectorNotification["update"]["event"],
): Promise<void> {
  const redstonePriceUsd = await fetchRedStonePriceUsd(REDSTONE_SYMBOL);
  const result = crossCheckPrice(
    BigInt(event.price),
    event.decimals,
    redstonePriceUsd,
    DIVERGENCE_HARD_BPS,
  );
  log(
    `cross-check: reflector=$${result.reflectorPriceUsd} redstone=$${result.redstonePriceUsd} ` +
      `divergence=${result.divergenceBps}bps shouldPause=${result.shouldPause}`,
  );
  if (result.shouldPause) {
    await triggerGuardianPause();
  }
}

export function createReflectorWebhookServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== PATH) {
      res.writeHead(404).end();
      return;
    }
    readJsonBody(req)
      .then(async (body) => {
        if (!isReflectorNotification(body)) {
          res.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ error: "malformed notification body" }),
          );
          return;
        }
        const nowSeconds = Math.floor(Date.now() / 1000);
        const result = tracker.recordNotification(body, nowSeconds);
        log(`notification from ${body.verifier}: ${result.status}`);

        if (result.status === "quorum-reached") {
          try {
            await handleConfirmedUpdate(result.event);
          } catch (err) {
            log(`error handling confirmed update: ${(err as Error).message}`);
            res.writeHead(502, { "content-type": "application/json" }).end(
              JSON.stringify({ status: result.status, error: "cross-check or pause failed" }),
            );
            return;
          }
        }
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ status: result.status }),
        );
      })
      .catch((err: Error) => {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ error: err.message }),
        );
      });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createReflectorWebhookServer();
  server.listen(PORT, () => {
    log(
      `reflector webhook server listening on :${PORT}${PATH}, ` +
        `quorum=${QUORUM_SIZE}/${TRUSTED_VERIFIERS.length} trusted verifiers`,
    );
  });
}
