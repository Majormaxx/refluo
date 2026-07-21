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





export interface Proposal {
  args: Array<any>;
  eta: u64;
  fn_name: string;
  proposer: string;
  target: string;
}




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
   * Construct and simulate a init transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time bootstrap for the address that can cancel a pending
   * proposal. Rejects a second call so a later caller can't take over
   * cancel authority out from under the vault that deployed this.
   */
  init: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cancel transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-gated, not proposer-gated: the point is that a party other
   * than whoever proposed can kill a proposal they didn't sign off on.
   */
  cancel: ({id, admin}: {id: u64, admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a execute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless by design, per doctrine: bounded (the delay already
   * happened), revocable (admin could have cancelled before now),
   * observable (`ProposeEvent` fired 24h ago). Nobody's signature adds
   * security here that the elapsed delay didn't already provide, so
   * requiring one would only add friction. The target function's own
   * `require_auth()` is what actually gates the effect: this contract's
   * own address is normally the `admin` argument baked into `args` at
   * proposal time, and a contract's address self-authorizes when it is
   * itself the caller, so the target only accepts the call because it's
   * really coming from this timelock, not because whoever pressed
   * execute() proved anything.
   */
  execute: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<any>>>

  /**
   * Construct and simulate a propose transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  propose: ({proposer, target, fn_name, args}: {proposer: string, target: string, fn_name: string, args: Array<any>}, options?: MethodOptions) => Promise<AssembledTransaction<u64>>

  /**
   * Construct and simulate a get_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_proposal: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Proposal>>>

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
      new ContractSpec([ "AAAAAAAAALxPbmUtdGltZSBib290c3RyYXAgZm9yIHRoZSBhZGRyZXNzIHRoYXQgY2FuIGNhbmNlbCBhIHBlbmRpbmcKcHJvcG9zYWwuIFJlamVjdHMgYSBzZWNvbmQgY2FsbCBzbyBhIGxhdGVyIGNhbGxlciBjYW4ndCB0YWtlIG92ZXIKY2FuY2VsIGF1dGhvcml0eSBvdXQgZnJvbSB1bmRlciB0aGUgdmF1bHQgdGhhdCBkZXBsb3llZCB0aGlzLgAAAARpbml0AAAAAQAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAACAAAH0AAAAAtDb21tb25FcnJvcgA=",
        "AAAAAQAAAAAAAAAAAAAACFByb3Bvc2FsAAAABQAAAAAAAAAEYXJncwAAA+oAAAAAAAAAAAAAAANldGEAAAAABgAAAAAAAAAHZm5fbmFtZQAAAAARAAAAAAAAAAhwcm9wb3NlcgAAABMAAAAAAAAABnRhcmdldAAAAAAAEw==",
        "AAAAAAAAAINBZG1pbi1nYXRlZCwgbm90IHByb3Bvc2VyLWdhdGVkOiB0aGUgcG9pbnQgaXMgdGhhdCBhIHBhcnR5IG90aGVyCnRoYW4gd2hvZXZlciBwcm9wb3NlZCBjYW4ga2lsbCBhIHByb3Bvc2FsIHRoZXkgZGlkbid0IHNpZ24gb2ZmIG9uLgAAAAAGY2FuY2VsAAAAAAACAAAAAAAAAAJpZAAAAAAABgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAA+kAAAACAAAH0AAAAAtDb21tb25FcnJvcgA=",
        "AAAAAAAAAqpQZXJtaXNzaW9ubGVzcyBieSBkZXNpZ24sIHBlciBkb2N0cmluZTogYm91bmRlZCAodGhlIGRlbGF5IGFscmVhZHkKaGFwcGVuZWQpLCByZXZvY2FibGUgKGFkbWluIGNvdWxkIGhhdmUgY2FuY2VsbGVkIGJlZm9yZSBub3cpLApvYnNlcnZhYmxlIChgUHJvcG9zZUV2ZW50YCBmaXJlZCAyNGggYWdvKS4gTm9ib2R5J3Mgc2lnbmF0dXJlIGFkZHMKc2VjdXJpdHkgaGVyZSB0aGF0IHRoZSBlbGFwc2VkIGRlbGF5IGRpZG4ndCBhbHJlYWR5IHByb3ZpZGUsIHNvCnJlcXVpcmluZyBvbmUgd291bGQgb25seSBhZGQgZnJpY3Rpb24uIFRoZSB0YXJnZXQgZnVuY3Rpb24ncyBvd24KYHJlcXVpcmVfYXV0aCgpYCBpcyB3aGF0IGFjdHVhbGx5IGdhdGVzIHRoZSBlZmZlY3Q6IHRoaXMgY29udHJhY3Qncwpvd24gYWRkcmVzcyBpcyBub3JtYWxseSB0aGUgYGFkbWluYCBhcmd1bWVudCBiYWtlZCBpbnRvIGBhcmdzYCBhdApwcm9wb3NhbCB0aW1lLCBhbmQgYSBjb250cmFjdCdzIGFkZHJlc3Mgc2VsZi1hdXRob3JpemVzIHdoZW4gaXQgaXMKaXRzZWxmIHRoZSBjYWxsZXIsIHNvIHRoZSB0YXJnZXQgb25seSBhY2NlcHRzIHRoZSBjYWxsIGJlY2F1c2UgaXQncwpyZWFsbHkgY29taW5nIGZyb20gdGhpcyB0aW1lbG9jaywgbm90IGJlY2F1c2Ugd2hvZXZlciBwcmVzc2VkCmV4ZWN1dGUoKSBwcm92ZWQgYW55dGhpbmcuAAAAAAAHZXhlY3V0ZQAAAAABAAAAAAAAAAJpZAAAAAAABgAAAAEAAAPpAAAAAAAAB9AAAAALQ29tbW9uRXJyb3IA",
        "AAAAAAAAAAAAAAAHcHJvcG9zZQAAAAAEAAAAAAAAAAhwcm9wb3NlcgAAABMAAAAAAAAABnRhcmdldAAAAAAAEwAAAAAAAAAHZm5fbmFtZQAAAAARAAAAAAAAAARhcmdzAAAD6gAAAAAAAAABAAAABg==",
        "AAAABQAAAAAAAAAAAAAAC0NhbmNlbEV2ZW50AAAAAAEAAAAMY2FuY2VsX2V2ZW50AAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADEV4ZWN1dGVFdmVudAAAAAEAAAANZXhlY3V0ZV9ldmVudAAAAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFByb3Bvc2VFdmVudAAAAAEAAAANcHJvcG9zZV9ldmVudAAAAAAAAAIAAAAAAAAAAmlkAAAAAAAGAAAAAQAAAAAAAAADZXRhAAAAAAYAAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAMZ2V0X3Byb3Bvc2FsAAAAAQAAAAAAAAACaWQAAAAAAAYAAAABAAAD6QAAB9AAAAAIUHJvcG9zYWwAAAfQAAAAC0NvbW1vbkVycm9yAA==",
        "AAAABAAAAAAAAAAAAAAAC0NvbW1vbkVycm9yAAAAAAcAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAABAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAACAAAAAAAAAAZQYXVzZWQAAAAAAAMAAAAAAAAACVN0YWxlRGF0YQAAAAAAAAQAAAAAAAAAC0NhcEV4Y2VlZGVkAAAAAAUAAAAAAAAAC1JhdGVMaW1pdGVkAAAAAAYAAAAAAAAACEJhZFN0YXRlAAAABw==" ]),
      options
    )
  }
  public readonly fromJSON = {
    init: this.txFromJSON<Result<void>>,
        cancel: this.txFromJSON<Result<void>>,
        execute: this.txFromJSON<Result<any>>,
        propose: this.txFromJSON<u64>,
        get_proposal: this.txFromJSON<Result<Proposal>>
  }
}