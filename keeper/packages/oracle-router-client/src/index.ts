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





export type DataKey = {tag: "Config", values: readonly [Asset]} | {tag: "LastAccepted", values: readonly [Asset]} | {tag: "OneFeedSince", values: readonly [Asset]};


/**
 * Local mirror of refluo-common's PriceQuote, not a shared dependency —
 * oracle-router is isolated on its own soroban-sdk version (adr/0005), so
 * refluo-common (built against 26.1.0) is not importable here.
 */
export interface PriceQuote {
  /**
 * max(feeds) for liability-side valuation.
 */
conservative_high: i128;
  /**
 * min(feeds) for collateral-side valuation.
 */
conservative_low: i128;
  /**
 * Scaled to ROUTER_DECIMALS.
 */
price: i128;
  status: OracleStatus;
  timestamp: u64;
}


export const RouterError = {
  1: {message:"NotInitialized"},
  2: {message:"InvalidConfig"}
}



export enum OracleStatus {
  Healthy = 0,
  OneFeed = 1,
  Degraded = 2,
  HardStop = 3,
}


export interface AssetOracleConfig {
  divergence_hard: u32;
  divergence_soft: u32;
  max_roc_per_update: u32;
  max_staleness_primary: u64;
  max_staleness_secondary: u64;
  /**
 * The Asset key to pass to the primary feed's own lastprice()/prices()
 * calls — NOT necessarily the router's logical asset key. Confirmed on
 * real testnet: Reflector keys XLM as `Other(Symbol("XLM"))` while
 * RedStone keys the same asset as `Stellar(<SAC address>)`. Each
 * provider's own addressing scheme has to be stored per-feed; a
 * single shared Asset value across both calls is wrong.
 */
primary_asset: Asset;
  primary_feed: string;
  secondary_asset: Asset;
  secondary_feed: string;
  twap_periods: u32;
}

/**
 * Asset type
 */
export type Asset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};


/**
 * Price data for an asset at a specific timestamp
 */
export interface PriceData {
  price: i128;
  timestamp: u64;
}

export interface Client {
  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<AssetOracleConfig>>

  /**
   * Construct and simulate a get_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Main read. Every other Refluo contract calls this, never a feed
   * directly.
   */
  get_price: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<PriceQuote>>

  /**
   * Construct and simulate a set_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Will be timelock-gated once the timelock contract is integrated. No
   * admin check yet at this scaffold stage.
   */
  set_config: ({asset, cfg}: {asset: Asset, cfg: AssetOracleConfig}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a check_and_trip transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless crank: anyone can call this, and on a genuinely
   * degraded read it really pauses `health_monitor`, a real
   * cross-contract call, not a status callers have to notice and act
   * on themselves. Self-authorizing: this contract's own address is
   * the `guardian` argument, valid only because this contract is
   * really the caller in that frame, the same pattern `timelock` uses
   * to call `risk-engine`. Uses `try_pause` deliberately: a vault that
   * hasn't registered OracleRouter as a guardian on its own
   * `health_monitor` must still get a correct degraded/not-degraded
   * answer back, not a reverted call. See adr/0010.
   */
  check_and_trip: ({asset, health_monitor}: {asset: Asset, health_monitor: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

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
      new ContractSpec([ "AAAABQAAAAAAAAAAAAAABlB4V2FybgAAAAAAAQAAAAdweF93YXJuAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAAB3ByaW1hcnkAAAAACwAAAAAAAAAAAAAACXNlY29uZGFyeQAAAAAAAAsAAAAAAAAAAAAAAA5kaXZlcmdlbmNlX2JwcwAAAAAABAAAAAAAAAAC",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAAAwAAAAEAAAAAAAAABkNvbmZpZwAAAAAAAQAAB9AAAAAFQXNzZXQAAAAAAAABAAAAAAAAAAxMYXN0QWNjZXB0ZWQAAAABAAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAADE9uZUZlZWRTaW5jZQAAAAEAAAfQAAAABUFzc2V0AAAA",
        "AAAAAQAAAMxMb2NhbCBtaXJyb3Igb2YgcmVmbHVvLWNvbW1vbidzIFByaWNlUXVvdGUsIG5vdCBhIHNoYXJlZCBkZXBlbmRlbmN5IOKAlApvcmFjbGUtcm91dGVyIGlzIGlzb2xhdGVkIG9uIGl0cyBvd24gc29yb2Jhbi1zZGsgdmVyc2lvbiAoYWRyLzAwMDUpLCBzbwpyZWZsdW8tY29tbW9uIChidWlsdCBhZ2FpbnN0IDI2LjEuMCkgaXMgbm90IGltcG9ydGFibGUgaGVyZS4AAAAAAAAAClByaWNlUXVvdGUAAAAAAAUAAAAobWF4KGZlZWRzKSBmb3IgbGlhYmlsaXR5LXNpZGUgdmFsdWF0aW9uLgAAABFjb25zZXJ2YXRpdmVfaGlnaAAAAAAAAAsAAAApbWluKGZlZWRzKSBmb3IgY29sbGF0ZXJhbC1zaWRlIHZhbHVhdGlvbi4AAAAAAAAQY29uc2VydmF0aXZlX2xvdwAAAAsAAAAaU2NhbGVkIHRvIFJPVVRFUl9ERUNJTUFMUy4AAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAABnN0YXR1cwAAAAAH0AAAAAxPcmFjbGVTdGF0dXMAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAABQAAAAAAAAAAAAAAClB4RGVncmFkZWQAAAAAAAEAAAALcHhfZGVncmFkZWQAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAAAI=",
        "AAAABAAAAAAAAAAAAAAAC1JvdXRlckVycm9yAAAAAAIAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAABAAAAAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAAAg==",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAABAAAH0AAAABFBc3NldE9yYWNsZUNvbmZpZwAAAA==",
        "AAAABQAAAAAAAAAAAAAAC1B4UmVjb3ZlcmVkAAAAAAEAAAAMcHhfcmVjb3ZlcmVkAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAAAI=",
        "AAAABQAAAAAAAAAAAAAAC1B4Um9jUmVqZWN0AAAAAAEAAAANcHhfcm9jX3JlamVjdAAAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAAA29sZAAAAAALAAAAAAAAAAAAAAADbmV3AAAAAAsAAAAAAAAAAg==",
        "AAAAAwAAAAAAAAAAAAAADE9yYWNsZVN0YXR1cwAAAAQAAAAAAAAAB0hlYWx0aHkAAAAAAAAAAAAAAAAHT25lRmVlZAAAAAABAAAAAAAAAAhEZWdyYWRlZAAAAAIAAAAAAAAACEhhcmRTdG9wAAAAAw==",
        "AAAAAAAAAElNYWluIHJlYWQuIEV2ZXJ5IG90aGVyIFJlZmx1byBjb250cmFjdCBjYWxscyB0aGlzLCBuZXZlciBhIGZlZWQKZGlyZWN0bHkuAAAAAAAACWdldF9wcmljZQAAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAEAAAfQAAAAClByaWNlUXVvdGUAAA==",
        "AAAAAAAAAGtXaWxsIGJlIHRpbWVsb2NrLWdhdGVkIG9uY2UgdGhlIHRpbWVsb2NrIGNvbnRyYWN0IGlzIGludGVncmF0ZWQuIE5vCmFkbWluIGNoZWNrIHlldCBhdCB0aGlzIHNjYWZmb2xkIHN0YWdlLgAAAAAKc2V0X2NvbmZpZwAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAANjZmcAAAAH0AAAABFBc3NldE9yYWNsZUNvbmZpZwAAAAAAAAA=",
        "AAAAAQAAAAAAAAAAAAAAEUFzc2V0T3JhY2xlQ29uZmlnAAAAAAAACgAAAAAAAAAPZGl2ZXJnZW5jZV9oYXJkAAAAAAQAAAAAAAAAD2RpdmVyZ2VuY2Vfc29mdAAAAAAEAAAAAAAAABJtYXhfcm9jX3Blcl91cGRhdGUAAAAAAAQAAAAAAAAAFW1heF9zdGFsZW5lc3NfcHJpbWFyeQAAAAAAAAYAAAAAAAAAF21heF9zdGFsZW5lc3Nfc2Vjb25kYXJ5AAAAAAYAAAF/VGhlIEFzc2V0IGtleSB0byBwYXNzIHRvIHRoZSBwcmltYXJ5IGZlZWQncyBvd24gbGFzdHByaWNlKCkvcHJpY2VzKCkKY2FsbHMg4oCUIE5PVCBuZWNlc3NhcmlseSB0aGUgcm91dGVyJ3MgbG9naWNhbCBhc3NldCBrZXkuIENvbmZpcm1lZCBvbgpyZWFsIHRlc3RuZXQ6IFJlZmxlY3RvciBrZXlzIFhMTSBhcyBgT3RoZXIoU3ltYm9sKCJYTE0iKSlgIHdoaWxlClJlZFN0b25lIGtleXMgdGhlIHNhbWUgYXNzZXQgYXMgYFN0ZWxsYXIoPFNBQyBhZGRyZXNzPilgLiBFYWNoCnByb3ZpZGVyJ3Mgb3duIGFkZHJlc3Npbmcgc2NoZW1lIGhhcyB0byBiZSBzdG9yZWQgcGVyLWZlZWQ7IGEKc2luZ2xlIHNoYXJlZCBBc3NldCB2YWx1ZSBhY3Jvc3MgYm90aCBjYWxscyBpcyB3cm9uZy4AAAAADXByaW1hcnlfYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAxwcmltYXJ5X2ZlZWQAAAATAAAAAAAAAA9zZWNvbmRhcnlfYXNzZXQAAAAH0AAAAAVBc3NldAAAAAAAAAAAAAAOc2Vjb25kYXJ5X2ZlZWQAAAAAABMAAAAAAAAADHR3YXBfcGVyaW9kcwAAAAQ=",
        "AAAAAAAAAmFQZXJtaXNzaW9ubGVzcyBjcmFuazogYW55b25lIGNhbiBjYWxsIHRoaXMsIGFuZCBvbiBhIGdlbnVpbmVseQpkZWdyYWRlZCByZWFkIGl0IHJlYWxseSBwYXVzZXMgYGhlYWx0aF9tb25pdG9yYCwgYSByZWFsCmNyb3NzLWNvbnRyYWN0IGNhbGwsIG5vdCBhIHN0YXR1cyBjYWxsZXJzIGhhdmUgdG8gbm90aWNlIGFuZCBhY3QKb24gdGhlbXNlbHZlcy4gU2VsZi1hdXRob3JpemluZzogdGhpcyBjb250cmFjdCdzIG93biBhZGRyZXNzIGlzCnRoZSBgZ3VhcmRpYW5gIGFyZ3VtZW50LCB2YWxpZCBvbmx5IGJlY2F1c2UgdGhpcyBjb250cmFjdCBpcwpyZWFsbHkgdGhlIGNhbGxlciBpbiB0aGF0IGZyYW1lLCB0aGUgc2FtZSBwYXR0ZXJuIGB0aW1lbG9ja2AgdXNlcwp0byBjYWxsIGByaXNrLWVuZ2luZWAuIFVzZXMgYHRyeV9wYXVzZWAgZGVsaWJlcmF0ZWx5OiBhIHZhdWx0IHRoYXQKaGFzbid0IHJlZ2lzdGVyZWQgT3JhY2xlUm91dGVyIGFzIGEgZ3VhcmRpYW4gb24gaXRzIG93bgpgaGVhbHRoX21vbml0b3JgIG11c3Qgc3RpbGwgZ2V0IGEgY29ycmVjdCBkZWdyYWRlZC9ub3QtZGVncmFkZWQKYW5zd2VyIGJhY2ssIG5vdCBhIHJldmVydGVkIGNhbGwuIFNlZSBhZHIvMDAxMC4AAAAAAAAOY2hlY2tfYW5kX3RyaXAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAAAAAAOaGVhbHRoX21vbml0b3IAAAAAABMAAAABAAAAAQ==",
        "AAAAAgAAAApBc3NldCB0eXBlAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAC9QcmljZSBkYXRhIGZvciBhbiBhc3NldCBhdCBhIHNwZWNpZmljIHRpbWVzdGFtcAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==" ]),
      options
    )
  }
  public readonly fromJSON = {
    config: this.txFromJSON<AssetOracleConfig>,
        get_price: this.txFromJSON<PriceQuote>,
        set_config: this.txFromJSON<null>,
        check_and_trip: this.txFromJSON<boolean>
  }
}