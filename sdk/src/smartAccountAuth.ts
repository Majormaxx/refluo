// The SDK's signing module (adr/0016): constructs and submits a real,
// multi-party-authorized transaction through a `stellar-accounts`
// `SmartAccount` / `CustomAccountInterface` vault. This is the exact
// capability adr/0008 found genuinely missing from plain `stellar-cli`,
// not a gap in the contracts: a custom account's own authorization entry
// carries a bespoke `AuthPayload` (context rule selection plus a signer
// map), not a standard Ed25519 signature, and each co-signing delegated
// admin's real authorization is a *separate* synthetic
// `require_auth_for_args` entry the host never surfaces from a plain
// simulation against an unauthenticated call.
//
// The approach, confirmed live against a real deployed vault:
//   1. Simulate the target call once with an empty (void) vault auth
//      entry to learn the entry's assigned nonce, needed to compute the
//      exact digest every co-signer must authorize.
//   2. Build the vault's own `AuthPayload` signature by hand (the one
//      piece with no standard signing convention) and a real,
//      individually-signed synthetic entry per co-signer.
//   3. Re-simulate with those real (non-void) entries attached. Once the
//      auth is real, the host actually executes `__check_auth` and every
//      cross-call it makes during simulation, so the full footprint and
//      resource cost come back correctly discovered, not guessed.
//   4. Assemble the final transaction from that second simulation
//      (`assembleTransaction` preserves auth entries already present on
//      the operation rather than overwriting them) and sign the envelope
//      with the fee-paying source.
import {
  Account,
  Address,
  Keypair,
  Networks,
  Transaction,
  authorizeEntry,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

const DEFAULT_VALID_LEDGERS = 100;

export interface AuthorizeSmartAccountCallParams {
  server: rpc.Server;
  networkPassphrase: string;
  /** The smart account (vault) contract address whose own authorization
   * entry needs the custom AuthPayload construction. */
  vaultAddress: string;
  /** Which context rule this call should be validated against, matching
   * the rule's own id on the vault (e.g. 0 for R_ADMIN). */
  contextRuleId: number;
  /** An unsigned transaction with exactly one invokeHostFunction
   * operation, built by the caller against the target contract (the
   * vault itself for admin actions, or any other contract the vault is
   * the funding/authorizing party for). */
  unsignedTx: Transaction;
  /** The real co-signing delegated admin keypairs. Must meet or exceed
   * whatever threshold the vault's policy for this context rule
   * requires; this module has no opinion on the threshold itself, that
   * is the policy contract's job to enforce. */
  coSigners: Keypair[];
  /** The fee-paying source account's real signing key. May or may not
   * be one of the co-signers. */
  sourceKeypair: Keypair;
  validUntilLedgerSeq?: number;
}

/** Signer::Delegated(Address) -> ScVal::Vec([Symbol("Delegated"), Address]),
 * the real stellar-accounts enum encoding (confirmed live: the host
 * decodes this into a genuine `Signer::Delegated` and successfully
 * dispatches to `authenticate()`). Exported for unit testing. */
export function delegatedSignerScVal(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(address).toScVal(),
  ]);
}

/** AuthPayload { signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32> },
 * fields sorted alphabetically by symbol name per soroban-sdk's
 * #[contracttype] struct convention (confirmed live: the host correctly
 * decodes this exact shape inside __check_auth). Signature bytes for each
 * Delegated signer are ignored by stellar-accounts' own `authenticate()`
 * (only External signers check them), so empty bytes are correct. Map
 * entries are canonically ordered by raw ScVal byte comparison (confirmed
 * live: string/base64 comparison disagrees with byte order at alphabet
 * boundaries and a real 2-of-3 call was rejected with a decode error
 * until this was fixed). Exported for unit testing. */
export function buildAuthPayloadScVal(
  contextRuleIdsScVal: xdr.ScVal,
  coSignerAddresses: string[],
): xdr.ScVal {
  const signersMapScVal = xdr.ScVal.scvMap(
    coSignerAddresses
      .map((addr) => delegatedSignerScVal(addr))
      .map((key) => ({ key, keyXdr: key.toXDR() }))
      .sort((a, b) => Buffer.compare(a.keyXdr, b.keyXdr))
      .map(
        ({ key }) =>
          new xdr.ScMapEntry({ key, val: xdr.ScVal.scvBytes(Buffer.alloc(0)) }),
      ),
  );
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: contextRuleIdsScVal,
    }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signers"), val: signersMapScVal }),
  ]);
}

function randomNonce(): xdr.Int64 {
  return new xdr.Int64(BigInt(Keypair.random().rawPublicKey().readBigInt64BE(0)));
}

/** The number of `Context`s `__check_auth` receives for one address's
 * entry is not always one: a contract can call `require_auth()` more than
 * once for the same address within a single transaction (confirmed live
 * against Soroswap's real router, whose `swap_exact_tokens_for_tokens`
 * requires the caller's own auth at its top level *and* again inside its
 * internal token transfer). The host batches every such requirement for
 * one address into a single entry and passes them all to one
 * `__check_auth` call, so `context_rule_ids` must have one element per
 * node in this entry's own invocation tree (root plus every
 * subInvocation, recursively), not a fixed length of one. */
export function countInvocationNodes(invocation: xdr.SorobanAuthorizedInvocation): number {
  return (
    1 +
    invocation
      .subInvocations()
      .reduce((sum, sub) => sum + countInvocationNodes(sub), 0)
  );
}

// The public testnet RPC load-balances across backend nodes that
// occasionally 503 or drop a connection under load; retry the raw network
// call rather than surface a transient blip as a real failure. Never
// wraps a legitimate simulation/transaction failure result, only a
// thrown exception from the transport itself.
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

/** Builds and submits a real transaction authorized through a
 * `stellar-accounts` smart account vault, gathering real co-signer
 * signatures for the given context rule. Returns the transaction result
 * once it lands (or throws on a real on-chain failure). */
export async function authorizeAndSendSmartAccountCall(
  params: AuthorizeSmartAccountCallParams,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const {
    server,
    networkPassphrase,
    vaultAddress,
    contextRuleId,
    unsignedTx,
    coSigners,
    sourceKeypair,
  } = params;

  if (coSigners.length === 0) {
    throw new Error("authorizeAndSendSmartAccountCall requires at least one co-signer");
  }

  const currentLedger = await withRetry(() => server.getLatestLedger());
  const validUntilLedgerSeq =
    params.validUntilLedgerSeq ?? currentLedger.sequence + DEFAULT_VALID_LEDGERS;

  // Step 1: simulate with empty auth to learn the vault's own entry
  // (specifically its freshly assigned nonce).
  const initialSim = await withRetry(() => server.simulateTransaction(unsignedTx));
  if (rpc.Api.isSimulationError(initialSim)) {
    throw new Error(`initial simulation failed: ${initialSim.error}`);
  }
  const assembledInitial = rpc.assembleTransaction(unsignedTx, initialSim).build();
  const initialInvokeOp = assembledInitial
    .toEnvelope()
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp();
  const vaultAuthEntries = initialInvokeOp
    .auth()
    .filter(
      (e) =>
        Address.fromScAddress(e.credentials().address().address()).toString() ===
        vaultAddress,
    );
  if (vaultAuthEntries.length !== 1) {
    throw new Error(
      `expected exactly one auth entry for the vault, found ${vaultAuthEntries.length}. ` +
        "This module currently supports a single-context call authorized once by the vault.",
    );
  }
  const vaultEntry = vaultAuthEntries[0];

  // Step 2: compute signature_payload (the Hash<32> __check_auth
  // receives) using authorizeEntry's own tested preimage construction,
  // then auth_digest = sha256(signature_payload || context_rule_ids.to_xdr()),
  // exactly matching stellar-accounts' own do_check_auth formula.
  let signaturePayload: Buffer | null = null;
  await authorizeEntry(
    vaultEntry,
    async (preimage) => {
      signaturePayload = hash(preimage.toXDR());
      return Buffer.alloc(64);
    },
    validUntilLedgerSeq,
    networkPassphrase,
  ).catch(() => {
    // The dummy signature never verifies; only signaturePayload matters.
  });
  if (!signaturePayload) {
    throw new Error("failed to compute signature_payload for the vault's auth entry");
  }

  const contextCount = countInvocationNodes(vaultEntry.rootInvocation());
  const contextRuleIdsScVal = xdr.ScVal.scvVec(
    Array.from({ length: contextCount }, () => xdr.ScVal.scvU32(contextRuleId)),
  );
  const authDigest = hash(
    Buffer.concat([signaturePayload, contextRuleIdsScVal.toXDR()]),
  );

  // Step 3: build the vault's own custom AuthPayload signature, bypassing
  // authorizeEntry's standard {public_key,signature} formatting (correct
  // for a co-signer's classic address, wrong for a custom account's own
  // bespoke Signature associated type).
  const coSignerAddresses = coSigners.map((kp) => kp.publicKey());
  const authPayloadScVal = buildAuthPayloadScVal(contextRuleIdsScVal, coSignerAddresses);
  const filledVaultEntry = xdr.SorobanAuthorizationEntry.fromXDR(vaultEntry.toXDR());
  const vaultAddrCreds = filledVaultEntry.credentials().address();
  vaultAddrCreds.signatureExpirationLedger(validUntilLedgerSeq);
  vaultAddrCreds.signature(authPayloadScVal);

  // Step 4: build one real, individually-signed synthetic entry per
  // co-signer for the require_auth_for_args call stellar-accounts'
  // authenticate() makes internally: {contract: vault, function_name:
  // "__check_auth", args: [auth_digest]} — confirmed live, this is the
  // exact invocation shape the host expects to find a matching entry for.
  const coSignerEntries: xdr.SorobanAuthorizationEntry[] = [];
  for (const coSigner of coSigners) {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(vaultAddress).toScAddress(),
          functionName: "__check_auth",
          args: [xdr.ScVal.scvBytes(authDigest)],
        }),
      ),
      subInvocations: [],
    });
    let entry = new xdr.SorobanAuthorizationEntry({
      rootInvocation: invocation,
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(coSigner.publicKey()).toScAddress(),
          nonce: randomNonce(),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVec([]),
        }),
      ),
    });
    entry = await authorizeEntry(entry, coSigner, validUntilLedgerSeq, networkPassphrase);
    coSignerEntries.push(entry);
  }

  // Step 5: attach the real (non-void) entries and re-simulate. With real
  // auth present the host actually executes __check_auth and every
  // cross-call it makes, so the second simulation's footprint and
  // instruction budget are correctly discovered, not manually padded.
  const trialEnvelope = xdr.TransactionEnvelope.fromXDR(unsignedTx.toEnvelope().toXDR());
  trialEnvelope
    .v1()
    .tx()
    .operations()[0]
    .body()
    .invokeHostFunctionOp()
    .auth([filledVaultEntry, ...coSignerEntries]);
  const trialTx = new Transaction(trialEnvelope, networkPassphrase);

  const finalSim = await withRetry(() => server.simulateTransaction(trialTx));
  if (rpc.Api.isSimulationError(finalSim)) {
    throw new Error(`authorized-call simulation failed: ${finalSim.error}`);
  }
  const finalTx = rpc.assembleTransaction(trialTx, finalSim).build();
  finalTx.sign(sourceKeypair);

  const sendResult = await withRetry(() => server.sendTransaction(finalTx));
  if (sendResult.status === "ERROR") {
    throw new Error(`send failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  let getResult = await withRetry(() => server.getTransaction(sendResult.hash));
  while (getResult.status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    getResult = await withRetry(() => server.getTransaction(sendResult.hash));
  }
  if (getResult.status !== "SUCCESS") {
    throw new Error(`transaction failed on-chain: ${JSON.stringify(getResult)}`);
  }
  return getResult;
}

export { Networks, Account };
