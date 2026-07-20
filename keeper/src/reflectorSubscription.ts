// Reflector Subscriptions: real push-based price triggers, cross-checked
// against RedStone's real REST API before ever pausing anything
// (implementation-spec §9's sentinel loop). Pure logic here, no network
// or HTTP server; see reflectorWebhookServer.ts for the real receiver.
//
// The real Reflector node network is entirely off-chain for delivery:
// there is no on-chain callback into a subscriber's contract anywhere in
// Reflector's own real subscription contract source
// (github.com/reflector-network/reflector-subscription-contract). A
// subscriber registers an encrypted webhook URL on-chain, and Reflector's
// own real node cluster watches the chain and POSTs signed notification
// JSON to that URL directly over HTTP once trigger conditions are met.
// The signing scheme below (sortObjectKeys, sha256, Ed25519) is copied
// exactly from reflector-node's real source
// (src/domain/subscriptions/subscriptions-processor.js and
// reflector-shared's serialization-helper.js), not guessed: a webhook
// receiver has to reproduce a signer's own canonicalization byte for byte
// or every real signature fails to verify.
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

export interface OracleSymbol {
  asset: string;
  source: string;
}

/** Matches the real notification's `update` object shape exactly
 * (reflector-node's TriggerEvent.update), field-for-field. */
export interface ReflectorUpdate {
  subscription: string;
  base: OracleSymbol;
  quote: OracleSymbol;
  decimals: number;
  price: string;
  prevPrice: string;
  timestamp: number;
}

export interface ReflectorNotification {
  update: {
    contract: string;
    events: string[];
    event: ReflectorUpdate;
    root: string;
  };
  signature: string;
  verifier: string;
}

/** Recursively sorts object keys alphabetically, matching
 * @reflector/reflector-shared's real `sortObjectKeys` exactly (confirmed
 * from source): arrays map element-wise, primitives pass through
 * unchanged, only plain objects get their keys reordered. */
export function sortObjectKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort((a, b) =>
    a.localeCompare(b),
  )) {
    sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** sha256(JSON.stringify(sortObjectKeys(update))), the exact preimage a
 * real Reflector node signs (confirmed from
 * subscriptions-processor.js's TriggerEvent.computeHash). */
export function computeUpdateHash(update: ReflectorUpdate): Buffer {
  const canonical = JSON.stringify(sortObjectKeys(update));
  return createHash("sha256").update(Buffer.from(canonical)).digest();
}

/** Verifies one real Reflector node's signature over a real notification's
 * `update` payload. A single node's signature is not itself trust, real
 * nodes each sign and send independently (the docs' own example shows
 * one notification per node for the same event); callers should require
 * a real quorum across multiple distinct `verifier` keys before treating
 * a price as confirmed, not act on the first signature that verifies. */
export function verifyNotificationSignature(notification: ReflectorNotification): boolean {
  try {
    const hash = computeUpdateHash(notification.update.event);
    const signatureBytes = Buffer.from(notification.signature, "base64");
    return Keypair.fromPublicKey(notification.verifier).verify(hash, signatureBytes);
  } catch {
    return false;
  }
}

export interface CrossCheckResult {
  shouldPause: boolean;
  reflectorPriceUsd: number;
  redstonePriceUsd: number;
  divergenceBps: number;
}

/** Compares a verified Reflector-pushed price against a real RedStone
 * REST quote, matching the divergence-bps convention OracleRouter's own
 * on-chain check already uses (adr/0005), so a guardian pause triggered
 * from this off-chain corroboration means the same thing operationally
 * as one triggered by the on-chain divergence check. */
export function crossCheckPrice(
  reflectorPriceRaw: bigint,
  reflectorDecimals: number,
  redstonePriceUsd: number,
  divergenceHardBps: number,
): CrossCheckResult {
  const reflectorPriceUsd = Number(reflectorPriceRaw) / 10 ** reflectorDecimals;
  const divergenceBps = Math.round(
    (Math.abs(reflectorPriceUsd - redstonePriceUsd) / redstonePriceUsd) * 10_000,
  );
  return {
    shouldPause: divergenceBps >= divergenceHardBps,
    reflectorPriceUsd,
    redstonePriceUsd,
    divergenceBps,
  };
}

/** Real RedStone REST endpoint (api.redstone.finance/prices), confirmed
 * live: returns real current USD prices, not a mock or testnet-only
 * service. Used here as the independent corroboration source
 * implementation-spec §9 names ("corroborate vs RedStone REST"). */
export async function fetchRedStonePriceUsd(symbol: string): Promise<number> {
  const response = await fetch(
    `https://api.redstone.finance/prices?symbol=${encodeURIComponent(symbol)}`,
  );
  if (!response.ok) {
    throw new Error(`RedStone REST request failed: ${response.status}`);
  }
  const body = (await response.json()) as Array<{ value: number }>;
  if (body.length === 0) {
    throw new Error(`RedStone REST returned no price for ${symbol}`);
  }
  return body[0].value;
}
