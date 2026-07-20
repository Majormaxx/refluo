import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}






export type PauseTrigger = {tag: "Guardian", values: void} | {tag: "OracleAuto", values: void} | {tag: "Behavioral", values: void};

export const CommonError = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"Paused"},
  4: {message:"StaleData"},
  5: {message:"CapExceeded"},
  6: {message:"RateLimited"},
  7: {message:"BadState"}
}

export interface Client {
  /**
   * Construct and simulate a pause transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Any guardian in the configured set can trigger this. Cheap and
   * broad on purpose: false positives only block risk-increasing
   * actions, and the 72h auto-expiry bounds the cost of a bad trigger.
   */
  pause: ({guardian}: {guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * status() computes paused && now < pause_expiry lazily — no keeper
   * needed to un-pause, the ledger clock does it.
   */
  status: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a guardians transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  guardians: (options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<string>>>>

  /**
   * Construct and simulate a resume_early transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Only the configured admin (in production, the vault's own smart
   * account, so this composes with its own multisig auth) can resume
   * before the 72h auto-expiry.
   */
  resume_early: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a init_guardians transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  init_guardians: ({admin, guardians}: {admin: string, guardians: Array<string>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAABQAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAQAAAAZwYXVzZWQAAAAAAAIAAAAAAAAAB3RyaWdnZXIAAAAH0AAAAAxQYXVzZVRyaWdnZXIAAAABAAAAAAAAAAxwYXVzZV9leHBpcnkAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAB1Jlc3VtZWQAAAAAAQAAAAdyZXN1bWVkAAAAAAEAAAAAAAAABWVhcmx5AAAAAAAAAQAAAAEAAAAC",
        "AAAAAAAAAL5BbnkgZ3VhcmRpYW4gaW4gdGhlIGNvbmZpZ3VyZWQgc2V0IGNhbiB0cmlnZ2VyIHRoaXMuIENoZWFwIGFuZApicm9hZCBvbiBwdXJwb3NlOiBmYWxzZSBwb3NpdGl2ZXMgb25seSBibG9jayByaXNrLWluY3JlYXNpbmcKYWN0aW9ucywgYW5kIHRoZSA3MmggYXV0by1leHBpcnkgYm91bmRzIHRoZSBjb3N0IG9mIGEgYmFkIHRyaWdnZXIuAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAhndWFyZGlhbgAAABMAAAAA",
        "AAAAAgAAAAAAAAAAAAAADFBhdXNlVHJpZ2dlcgAAAAMAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAAAAAAAAAAACk9yYWNsZUF1dG8AAAAAAAAAAAAAAAAACkJlaGF2aW9yYWwAAA==",
        "AAAAAAAAAHFzdGF0dXMoKSBjb21wdXRlcyBwYXVzZWQgJiYgbm93IDwgcGF1c2VfZXhwaXJ5IGxhemlseSDigJQgbm8ga2VlcGVyCm5lZWRlZCB0byB1bi1wYXVzZSwgdGhlIGxlZGdlciBjbG9jayBkb2VzIGl0LgAAAAAAAAZzdGF0dXMAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAJZ3VhcmRpYW5zAAAAAAAAAAAAAAEAAAPpAAAD6gAAABMAAAfQAAAAC0NvbW1vbkVycm9yAA==",
        "AAAAAAAAAJxPbmx5IHRoZSBjb25maWd1cmVkIGFkbWluIChpbiBwcm9kdWN0aW9uLCB0aGUgdmF1bHQncyBvd24gc21hcnQKYWNjb3VudCwgc28gdGhpcyBjb21wb3NlcyB3aXRoIGl0cyBvd24gbXVsdGlzaWcgYXV0aCkgY2FuIHJlc3VtZQpiZWZvcmUgdGhlIDcyaCBhdXRvLWV4cGlyeS4AAAAMcmVzdW1lX2Vhcmx5AAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAOaW5pdF9ndWFyZGlhbnMAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAJZ3VhcmRpYW5zAAAAAAAD6gAAABMAAAAA",
        "AAAABAAAAAAAAAAAAAAAC0NvbW1vbkVycm9yAAAAAAcAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAABAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAACAAAAAAAAAAZQYXVzZWQAAAAAAAMAAAAAAAAACVN0YWxlRGF0YQAAAAAAAAQAAAAAAAAAC0NhcEV4Y2VlZGVkAAAAAAUAAAAAAAAAC1JhdGVMaW1pdGVkAAAAAAYAAAAAAAAACEJhZFN0YXRlAAAABw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    pause: this.txFromJSON<null>,
        status: this.txFromJSON<boolean>,
        guardians: this.txFromJSON<Result<Array<string>>>,
        resume_early: this.txFromJSON<null>,
        init_guardians: this.txFromJSON<null>
  }
}