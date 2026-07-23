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


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CDCUGTD3OPX3N474CKHQJRO2EWPNGYDZSV5MC3QJV3XRJHLGXCFMXSVO",
  }
} as const




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



export const AccessControlError = {
  2000: {message:"Unauthorized"},
  2001: {message:"AdminNotSet"},
  2002: {message:"IndexOutOfBounds"},
  2003: {message:"AdminRoleNotFound"},
  2004: {message:"RoleCountIsNotZero"},
  2005: {message:"RoleNotFound"},
  2006: {message:"AdminAlreadySet"},
  2007: {message:"RoleNotHeld"},
  2008: {message:"RoleIsEmpty"},
  2009: {message:"TransferInProgress"},
  2010: {message:"MaxRolesExceeded"}
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
   * Construct and simulate a extend transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Only the configured admin can extend an *active* pause before it
   * auto-expires, capped at `MAX_EXTENSIONS` real extensions so a
   * guardian trip can't be held open indefinitely by repeated admin
   * extensions. Same auth shape as `resume_early` (this contract has no
   * separate multisig of its own; that composes one layer up at the
   * vault's smart account, same as `resume_early`'s own comment notes).
   */
  extend: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * status() computes paused && now < pause_expiry lazily — no keeper
   * needed to un-pause, the ledger clock does it.
   */
  status: (options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a guardians transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  guardians: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a add_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Adds one guardian without disturbing the rest of the roster, a
   * real capability the old hand-rolled `Vec<Address>` never had (it
   * could only ever be replaced wholesale via `init_guardians`).
   */
  add_guardian: ({admin, guardian}: {admin: string, guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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

  /**
   * Construct and simulate a remove_guardian transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  remove_guardian: ({admin, guardian}: {admin: string, guardian: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
        "AAAABQAAAAAAAAAAAAAACEV4dGVuZGVkAAAAAQAAAAhleHRlbmRlZAAAAAIAAAAAAAAAD2V4dGVuc2lvbnNfdXNlZAAAAAAEAAAAAQAAAAAAAAAMcGF1c2VfZXhwaXJ5AAAABgAAAAAAAAAC",
        "AAAAAAAAAL5BbnkgZ3VhcmRpYW4gaW4gdGhlIGNvbmZpZ3VyZWQgc2V0IGNhbiB0cmlnZ2VyIHRoaXMuIENoZWFwIGFuZApicm9hZCBvbiBwdXJwb3NlOiBmYWxzZSBwb3NpdGl2ZXMgb25seSBibG9jayByaXNrLWluY3JlYXNpbmcKYWN0aW9ucywgYW5kIHRoZSA3MmggYXV0by1leHBpcnkgYm91bmRzIHRoZSBjb3N0IG9mIGEgYmFkIHRyaWdnZXIuAAAAAAAFcGF1c2UAAAAAAAABAAAAAAAAAAhndWFyZGlhbgAAABMAAAAA",
        "AAAAAgAAAAAAAAAAAAAADFBhdXNlVHJpZ2dlcgAAAAMAAAAAAAAAAAAAAAhHdWFyZGlhbgAAAAAAAAAAAAAACk9yYWNsZUF1dG8AAAAAAAAAAAAAAAAACkJlaGF2aW9yYWwAAA==",
        "AAAAAAAAAYZPbmx5IHRoZSBjb25maWd1cmVkIGFkbWluIGNhbiBleHRlbmQgYW4gKmFjdGl2ZSogcGF1c2UgYmVmb3JlIGl0CmF1dG8tZXhwaXJlcywgY2FwcGVkIGF0IGBNQVhfRVhURU5TSU9OU2AgcmVhbCBleHRlbnNpb25zIHNvIGEKZ3VhcmRpYW4gdHJpcCBjYW4ndCBiZSBoZWxkIG9wZW4gaW5kZWZpbml0ZWx5IGJ5IHJlcGVhdGVkIGFkbWluCmV4dGVuc2lvbnMuIFNhbWUgYXV0aCBzaGFwZSBhcyBgcmVzdW1lX2Vhcmx5YCAodGhpcyBjb250cmFjdCBoYXMgbm8Kc2VwYXJhdGUgbXVsdGlzaWcgb2YgaXRzIG93bjsgdGhhdCBjb21wb3NlcyBvbmUgbGF5ZXIgdXAgYXQgdGhlCnZhdWx0J3Mgc21hcnQgYWNjb3VudCwgc2FtZSBhcyBgcmVzdW1lX2Vhcmx5YCdzIG93biBjb21tZW50IG5vdGVzKS4AAAAAAAZleHRlbmQAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAHFzdGF0dXMoKSBjb21wdXRlcyBwYXVzZWQgJiYgbm93IDwgcGF1c2VfZXhwaXJ5IGxhemlseSDigJQgbm8ga2VlcGVyCm5lZWRlZCB0byB1bi1wYXVzZSwgdGhlIGxlZGdlciBjbG9jayBkb2VzIGl0LgAAAAAAAAZzdGF0dXMAAAAAAAAAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAJZ3VhcmRpYW5zAAAAAAAAAAAAAAEAAAPqAAAAEw==",
        "AAAAAAAAALxBZGRzIG9uZSBndWFyZGlhbiB3aXRob3V0IGRpc3R1cmJpbmcgdGhlIHJlc3Qgb2YgdGhlIHJvc3RlciwgYQpyZWFsIGNhcGFiaWxpdHkgdGhlIG9sZCBoYW5kLXJvbGxlZCBgVmVjPEFkZHJlc3M+YCBuZXZlciBoYWQgKGl0CmNvdWxkIG9ubHkgZXZlciBiZSByZXBsYWNlZCB3aG9sZXNhbGUgdmlhIGBpbml0X2d1YXJkaWFuc2ApLgAAAAxhZGRfZ3VhcmRpYW4AAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAACGd1YXJkaWFuAAAAEwAAAAA=",
        "AAAAAAAAAJxPbmx5IHRoZSBjb25maWd1cmVkIGFkbWluIChpbiBwcm9kdWN0aW9uLCB0aGUgdmF1bHQncyBvd24gc21hcnQKYWNjb3VudCwgc28gdGhpcyBjb21wb3NlcyB3aXRoIGl0cyBvd24gbXVsdGlzaWcgYXV0aCkgY2FuIHJlc3VtZQpiZWZvcmUgdGhlIDcyaCBhdXRvLWV4cGlyeS4AAAAMcmVzdW1lX2Vhcmx5AAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAAAAAAAOaW5pdF9ndWFyZGlhbnMAAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAJZ3VhcmRpYW5zAAAAAAAD6gAAABMAAAAA",
        "AAAAAAAAAAAAAAAPcmVtb3ZlX2d1YXJkaWFuAAAAAAIAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAIZ3VhcmRpYW4AAAATAAAAAA==",
        "AAAABAAAAAAAAAAAAAAAC0NvbW1vbkVycm9yAAAAAAcAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAABAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAACAAAAAAAAAAZQYXVzZWQAAAAAAAMAAAAAAAAACVN0YWxlRGF0YQAAAAAAAAQAAAAAAAAAC0NhcEV4Y2VlZGVkAAAAAAUAAAAAAAAAC1JhdGVMaW1pdGVkAAAAAAYAAAAAAAAACEJhZFN0YXRlAAAABw==",
        "AAAABQAAACVFdmVudCBlbWl0dGVkIHdoZW4gYSByb2xlIGlzIGdyYW50ZWQuAAAAAAAAAAAAAAtSb2xlR3JhbnRlZAAAAAABAAAADHJvbGVfZ3JhbnRlZAAAAAMAAAAAAAAABHJvbGUAAAARAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAI=",
        "AAAABQAAACVFdmVudCBlbWl0dGVkIHdoZW4gYSByb2xlIGlzIHJldm9rZWQuAAAAAAAAAAAAAAtSb2xlUmV2b2tlZAAAAAABAAAADHJvbGVfcmV2b2tlZAAAAAMAAAAAAAAABHJvbGUAAAARAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAAAAAAAAGY2FsbGVyAAAAAAATAAAAAAAAAAI=",
        "AAAABAAAAAAAAAAAAAAAEkFjY2Vzc0NvbnRyb2xFcnJvcgAAAAAACwAAAAAAAAAMVW5hdXRob3JpemVkAAAH0AAAAAAAAAALQWRtaW5Ob3RTZXQAAAAH0QAAAAAAAAAQSW5kZXhPdXRPZkJvdW5kcwAAB9IAAAAAAAAAEUFkbWluUm9sZU5vdEZvdW5kAAAAAAAH0wAAAAAAAAASUm9sZUNvdW50SXNOb3RaZXJvAAAAAAfUAAAAAAAAAAxSb2xlTm90Rm91bmQAAAfVAAAAAAAAAA9BZG1pbkFscmVhZHlTZXQAAAAH1gAAAAAAAAALUm9sZU5vdEhlbGQAAAAH1wAAAAAAAAALUm9sZUlzRW1wdHkAAAAH2AAAAAAAAAASVHJhbnNmZXJJblByb2dyZXNzAAAAAAfZAAAAAAAAABBNYXhSb2xlc0V4Y2VlZGVkAAAH2g==" ]),
      options
    )
  }
  public readonly fromJSON = {
    pause: this.txFromJSON<null>,
        extend: this.txFromJSON<null>,
        status: this.txFromJSON<boolean>,
        guardians: this.txFromJSON<Array<string>>,
        add_guardian: this.txFromJSON<null>,
        resume_early: this.txFromJSON<null>,
        init_guardians: this.txFromJSON<null>,
        remove_guardian: this.txFromJSON<null>
  }
}