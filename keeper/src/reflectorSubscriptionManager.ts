// Real on-chain subscription lifecycle management via Reflector's own
// published `@reflector/subscription-client` (MIT, confirmed real npm
// package, github.com/reflector-network/reflector-subscription-client).
// Thin wrapper: this module's only job is wiring the keeper's own
// KEEPER_SECRET as the signer and exposing create/get/deposit/cancel as
// plain async functions matching the rest of this codebase's style,
// nothing reimplemented that the real client already does.
//
// `contractId` defaults (inside the real client) to
// CBNGTWIVRCD4FOJ24FGAKI6I5SDAXI7A4GWKSQS7E6UYSR4E4OHRI2JX, which is
// mainnet-only: extensive search (GitHub code search across the entire
// reflector-network org, the reflector-node and reflector-subscription-
// contract source, web search, reflector.network's own docs) turned up
// no real testnet deployment of the Subscriptions contract. This module
// accepts an explicit `contractId` override for exactly that reason: if
// a testnet instance is ever deployed, point REFLECTOR_SUBSCRIPTION_CONTRACT_ID
// at it and this code works unmodified. Until then, calling any of these
// functions against testnet will fail (no contract at that address on
// this network) — a real, disclosed infrastructure gap, not a bug here.
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import SubscriptionClient, {
  type Subscription,
  type SubscriptionId,
  type SubscriptionInitParams,
  type SignTransactionCallback,
} from "@reflector/subscription-client";

export interface ReflectorSubscriptionManagerParams {
  rpcUrl: string;
  networkPassphrase: string;
  signerKeypair: Keypair;
  /** Override for a non-mainnet deployment; see module header. */
  contractId?: string;
}

export function createReflectorSubscriptionClient(
  params: ReflectorSubscriptionManagerParams,
): SubscriptionClient {
  // The published .d.ts marks callTimeout/defaultFee/noRestore (and
  // omits contractId/networkPassphrase entirely) as if required; the
  // real JS constructor (confirmed from source) defaults every one of
  // them (`params.defaultFee || '10000'`, etc.) and does accept
  // contractId/networkPassphrase. Casting through unknown to work
  // around the upstream package's own type declaration, not this
  // module's logic.
  return new SubscriptionClient({
    publicKey: params.signerKeypair.publicKey(),
    rpcUrl: params.rpcUrl,
    networkPassphrase: params.networkPassphrase,
    contractId: params.contractId,
    signTransaction: (async (xdrString, context) => {
      const tx = TransactionBuilder.fromXDR(xdrString, context.networkPassphrase);
      tx.sign(params.signerKeypair);
      return tx.toEnvelope().toXDR("base64");
    }) satisfies SignTransactionCallback,
  } as unknown as ConstructorParameters<typeof SubscriptionClient>[0]);
}

export async function createSubscription(
  client: SubscriptionClient,
  params: SubscriptionInitParams,
): Promise<Subscription> {
  return client.createSubscription(params);
}

export async function getSubscription(
  client: SubscriptionClient,
  subscriptionId: SubscriptionId,
): Promise<Subscription> {
  return client.getSubscription(subscriptionId);
}

export async function depositToSubscription(
  client: SubscriptionClient,
  subscriptionId: SubscriptionId,
  amount: string | bigint,
): Promise<void> {
  await client.deposit(subscriptionId, amount);
}

export async function cancelSubscription(
  client: SubscriptionClient,
  subscriptionId: SubscriptionId,
): Promise<void> {
  await client.cancel(subscriptionId);
}
