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
    contractId: "CDEGC5DI7R3GCKGUDRN3XIY5FWIKSGLW4UBVK4RMPWFAS3CWKV5BWZ5C",
  }
} as const

export type DataKey = {tag: "Config", values: readonly [string]} | {tag: "State", values: readonly [string]} | {tag: "Tier", values: readonly [string]} | {tag: "FeeBps", values: void} | {tag: "Admin", values: void};

export const RiskError = {
  1: {message:"NotInitialized"},
  2: {message:"Unauthorized"},
  3: {message:"CapExceeded"},
  4: {message:"InvalidTransition"},
  5: {message:"InvalidConfig"}
}


export interface TierState {
  tier0_target: i128;
  tier1_positions: Map<string, i128>;
}


export interface TierConfig {
  /**
 * Emergency trigger: real on-chain Tier 0 balance below this.
 */
critical_floor: i128;
  /**
 * Keeper-attested utilization (bps) at or above this triggers a full
 * drain (Emergency) via the utilization path, not just PreemptiveDrain.
 * Must be strictly greater than `preemptive_util_bps`, checked at
 * `init()`.
 */
full_drain_util_bps: u32;
  health_monitor: string;
  keeper: string;
  /**
 * Which asset's price status gates transitions — the vault's Tier 0
 * reserve asset (USDC).
 */
oracle_asset: Asset;
  oracle_router: string;
  /**
 * Keeper-attested utilization (bps) at or above this triggers
 * PreemptiveDrain via the utilization path.
 */
preemptive_util_bps: u32;
  tier0_bounds_max: i128;
  tier0_bounds_min: i128;
  /**
 * Total Tier 1 capital cap across all venues.
 */
tvl_cap: i128;
  usdc_token: string;
}

/**
 * The on-chain form of an operator's risk appetite: a named choice that
 * resolves to real `TierConfig` utilization thresholds instead of an
 * operator typing bps values by hand. This is deliberately just the
 * utilization thresholds, not `tier0_bounds`/`tvl_cap`/`critical_floor`,
 * those depend on the vault's actual capital, not on risk appetite, and
 * stay explicit inputs to `init_with_profile` either way.
 */
export enum RiskProfile {
  Conservative = 0,
  Balanced = 1,
  Aggressive = 2,
}

export enum SystemState {
  Normal = 0,
  PreemptiveDrain = 1,
  Emergency = 2,
  Paused = 3,
}



export interface MirroredPriceQuote {
  conservative_high: i128;
  conservative_low: i128;
  price: i128;
  status: MirroredOracleStatus;
  timestamp: u64;
}

/**
 * Mirrors oracle-router's OracleStatus. Cross-contract calls are
 * structural (XDR-level), so this local mirror is correct as long as the
 * field layout matches — the same principle as BlendRequest and the
 * per-feed Asset handling in oracle-router itself.
 */
export enum MirroredOracleStatus {
  Healthy = 0,
  OneFeed = 1,
  Degraded = 2,
  HardStop = 3,
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
   * Construct and simulate a init transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  init: ({account, cfg, tier0_target}: {account: string, cfg: TierConfig, tier0_target: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  state: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<SystemState>>

  /**
   * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  config: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<TierConfig>>

  /**
   * Construct and simulate a fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  fee_bps: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a init_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * One-time bootstrap for the global fee admin. In production this is
   * the deployed `timelock` contract's own address: `timelock`'s
   * `execute()` self-authorizes by passing its own address as the
   * `admin` argument, so raising a fee genuinely requires a proposal
   * that survived the 24h delay, per adr/0002 and adr/0007. Callable
   * once; re-running it after an admin is already set is rejected so a
   * later caller can't silently take over the fee-setting role.
   */
  init_admin: ({admin}: {admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a tier_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  tier_state: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<TierState>>

  /**
   * Construct and simulate a set_fee_bps transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Ships initialized to 0. Gated behind the stored admin (see
   * `init_admin`), not just any address that signs for itself, per
   * adr/0002 and adr/0007.
   */
  set_fee_bps: ({admin, new_fee_bps}: {admin: string, new_fee_bps: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a check_and_trip transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless crank: anyone can call this to move state to a more
   * conservative level when real, objectively-checkable conditions
   * warrant it. Never moves state to a less conservative level — that's
   * keeper_advance_state's job, deliberately gated tighter.
   */
  check_and_trip: ({account}: {account: string}, options?: MethodOptions) => Promise<AssembledTransaction<SystemState>>

  /**
   * Construct and simulate a deploy_allowed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The on-chain guarantee every policy depends on: never allow a
   * deployment that would push total Tier 1 capital above tvl_cap, and
   * never allow one at all above NORMAL.
   */
  deploy_allowed: ({account, amount}: {account: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a transfer_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Hands off fee governance to a new address, `timelock`'s own
   * contract address in production. Only the current admin signs;
   * `new_admin` does not, deliberately: a contract address can never
   * sign a transaction the way an account key can, `require_auth()` for
   * one only ever succeeds when that contract is the actual caller in
   * the frame, so requiring its consent here is impossible, not just
   * inconvenient. The current admin choosing the successor is the whole
   * trust boundary, matching the standard ownership-transfer pattern
   * used across the ecosystem.
   */
  transfer_admin: ({current_admin, new_admin}: {current_admin: string, new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_tier0_target transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  set_tier0_target: ({account, keeper, new_target}: {account: string, keeper: string, new_target: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a init_with_profile transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Same as `init`, except `preemptive_util_bps`/`full_drain_util_bps`
   * on `cfg` are overwritten by `profile`'s real preset thresholds
   * rather than trusted from the caller; every other field (addresses,
   * `tvl_cap`, `critical_floor`, `tier0_bounds_min`/`max`) is used as
   * given, since none of it is a function of risk appetite. Lets a
   * caller reuse the exact same `TierConfig` shape `init` takes,
   * naming a risk profile instead of typing bps values by hand for
   * just those two fields.
   */
  init_with_profile: ({account, profile, cfg, tier0_target}: {account: string, profile: RiskProfile, cfg: TierConfig, tier0_target: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a keeper_advance_state transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The only path that moves state to a less conservative level, or
   * triggers PreemptiveDrain via keeper-attested utilization rather
   * than oracle status. Every downward move requires the oracle to be
   * genuinely Healthy right now, verified live, not asserted.
   */
  keeper_advance_state: ({account, keeper, to, utilization_bps}: {account: string, keeper: string, to: SystemState, utilization_bps: Option<u32>}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a record_tier1_position transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Real enforcement of the same guarantee `deploy_allowed` advertises —
   * this used to be purely advisory (nothing here checked `tvl_cap` or
   * `SystemState` at all, any caller that skipped the `deploy_allowed`
   * pre-check could push a position arbitrarily high). Rejects for real
   * now, reusing `RiskError::CapExceeded` for both reasons
   * `deploy_allowed` already conflates into a single bool (over-cap, or
   * state not Normal) rather than inventing a new variant to
   * distinguish them.
   * 
   * The cap check here is deliberately *not* `deploy_allowed`'s own
   * formula: this function *sets* (not increments) `venue`'s position,
   * so the real new total is every *other* venue's current position plus
   * `amount` — reusing `deploy_allowed`'s "current total + amount"
   * formula unmodified would double-count `venue`'s own stale value on
   * every update to an existing position, not just a fresh deployment.
   */
  record_tier1_position: ({account, keeper, venue, amount}: {account: string, keeper: string, venue: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

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
      new ContractSpec([ "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABQAAAAEAAAAAAAAABkNvbmZpZwAAAAAAAQAAABMAAAABAAAAAAAAAAVTdGF0ZQAAAAAAAAEAAAATAAAAAQAAAAAAAAAEVGllcgAAAAEAAAATAAAAAAAAAAAAAAAGRmVlQnBzAAAAAAAAAAAAAAAAAAVBZG1pbgAAAA==",
        "AAAAAAAAAAAAAAAEaW5pdAAAAAMAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAADY2ZnAAAAB9AAAAAKVGllckNvbmZpZwAAAAAAAAAAAAx0aWVyMF90YXJnZXQAAAALAAAAAA==",
        "AAAAAAAAAAAAAAAFc3RhdGUAAAAAAAABAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAH0AAAAAtTeXN0ZW1TdGF0ZQA=",
        "AAAABAAAAAAAAAAAAAAACVJpc2tFcnJvcgAAAAAAAAUAAAAAAAAADk5vdEluaXRpYWxpemVkAAAAAAABAAAAAAAAAAxVbmF1dGhvcml6ZWQAAAACAAAAAAAAAAtDYXBFeGNlZWRlZAAAAAADAAAAAAAAABFJbnZhbGlkVHJhbnNpdGlvbgAAAAAAAAQAAAAAAAAADUludmFsaWRDb25maWcAAAAAAAAF",
        "AAAAAQAAAAAAAAAAAAAACVRpZXJTdGF0ZQAAAAAAAAIAAAAAAAAADHRpZXIwX3RhcmdldAAAAAsAAAAAAAAAD3RpZXIxX3Bvc2l0aW9ucwAAAAPsAAAAEwAAAAs=",
        "AAAAAAAAAAAAAAAGY29uZmlnAAAAAAABAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAH0AAAAApUaWVyQ29uZmlnAAA=",
        "AAAAAQAAAAAAAAAAAAAAClRpZXJDb25maWcAAAAAAAsAAAA7RW1lcmdlbmN5IHRyaWdnZXI6IHJlYWwgb24tY2hhaW4gVGllciAwIGJhbGFuY2UgYmVsb3cgdGhpcy4AAAAADmNyaXRpY2FsX2Zsb29yAAAAAAALAAAA0ktlZXBlci1hdHRlc3RlZCB1dGlsaXphdGlvbiAoYnBzKSBhdCBvciBhYm92ZSB0aGlzIHRyaWdnZXJzIGEgZnVsbApkcmFpbiAoRW1lcmdlbmN5KSB2aWEgdGhlIHV0aWxpemF0aW9uIHBhdGgsIG5vdCBqdXN0IFByZWVtcHRpdmVEcmFpbi4KTXVzdCBiZSBzdHJpY3RseSBncmVhdGVyIHRoYW4gYHByZWVtcHRpdmVfdXRpbF9icHNgLCBjaGVja2VkIGF0CmBpbml0KClgLgAAAAAAE2Z1bGxfZHJhaW5fdXRpbF9icHMAAAAABAAAAAAAAAAOaGVhbHRoX21vbml0b3IAAAAAABMAAAAAAAAABmtlZXBlcgAAAAAAEwAAAFlXaGljaCBhc3NldCdzIHByaWNlIHN0YXR1cyBnYXRlcyB0cmFuc2l0aW9ucyDigJQgdGhlIHZhdWx0J3MgVGllciAwCnJlc2VydmUgYXNzZXQgKFVTREMpLgAAAAAAAAxvcmFjbGVfYXNzZXQAAAfQAAAABUFzc2V0AAAAAAAAAAAAAA1vcmFjbGVfcm91dGVyAAAAAAAAEwAAAGVLZWVwZXItYXR0ZXN0ZWQgdXRpbGl6YXRpb24gKGJwcykgYXQgb3IgYWJvdmUgdGhpcyB0cmlnZ2VycwpQcmVlbXB0aXZlRHJhaW4gdmlhIHRoZSB1dGlsaXphdGlvbiBwYXRoLgAAAAAAABNwcmVlbXB0aXZlX3V0aWxfYnBzAAAAAAQAAAAAAAAAEHRpZXIwX2JvdW5kc19tYXgAAAALAAAAAAAAABB0aWVyMF9ib3VuZHNfbWluAAAACwAAACtUb3RhbCBUaWVyIDEgY2FwaXRhbCBjYXAgYWNyb3NzIGFsbCB2ZW51ZXMuAAAAAAd0dmxfY2FwAAAAAAsAAAAAAAAACnVzZGNfdG9rZW4AAAAAABM=",
        "AAAAAAAAAAAAAAAHZmVlX2JwcwAAAAAAAAAAAQAAAAQ=",
        "AAAAAwAAAY9UaGUgb24tY2hhaW4gZm9ybSBvZiBhbiBvcGVyYXRvcidzIHJpc2sgYXBwZXRpdGU6IGEgbmFtZWQgY2hvaWNlIHRoYXQKcmVzb2x2ZXMgdG8gcmVhbCBgVGllckNvbmZpZ2AgdXRpbGl6YXRpb24gdGhyZXNob2xkcyBpbnN0ZWFkIG9mIGFuCm9wZXJhdG9yIHR5cGluZyBicHMgdmFsdWVzIGJ5IGhhbmQuIFRoaXMgaXMgZGVsaWJlcmF0ZWx5IGp1c3QgdGhlCnV0aWxpemF0aW9uIHRocmVzaG9sZHMsIG5vdCBgdGllcjBfYm91bmRzYC9gdHZsX2NhcGAvYGNyaXRpY2FsX2Zsb29yYCwKdGhvc2UgZGVwZW5kIG9uIHRoZSB2YXVsdCdzIGFjdHVhbCBjYXBpdGFsLCBub3Qgb24gcmlzayBhcHBldGl0ZSwgYW5kCnN0YXkgZXhwbGljaXQgaW5wdXRzIHRvIGBpbml0X3dpdGhfcHJvZmlsZWAgZWl0aGVyIHdheS4AAAAAAAAAAAtSaXNrUHJvZmlsZQAAAAADAAAAAAAAAAxDb25zZXJ2YXRpdmUAAAAAAAAAAAAAAAhCYWxhbmNlZAAAAAEAAAAAAAAACkFnZ3Jlc3NpdmUAAAAAAAI=",
        "AAAAAwAAAAAAAAAAAAAAC1N5c3RlbVN0YXRlAAAAAAQAAAAAAAAABk5vcm1hbAAAAAAAAAAAAAAAAAAPUHJlZW1wdGl2ZURyYWluAAAAAAEAAAAAAAAACUVtZXJnZW5jeQAAAAAAAAIAAAAAAAAABlBhdXNlZAAAAAAAAw==",
        "AAAABQAAAAAAAAAAAAAADFN0YXRlQ2hhbmdlZAAAAAEAAAANc3RhdGVfY2hhbmdlZAAAAAAAAAMAAAAAAAAAB2FjY291bnQAAAAAEwAAAAEAAAAAAAAABGZyb20AAAfQAAAAC1N5c3RlbVN0YXRlAAAAAAAAAAAAAAAAAnRvAAAAAAfQAAAAC1N5c3RlbVN0YXRlAAAAAAAAAAAC",
        "AAAAAAAAAb5PbmUtdGltZSBib290c3RyYXAgZm9yIHRoZSBnbG9iYWwgZmVlIGFkbWluLiBJbiBwcm9kdWN0aW9uIHRoaXMgaXMKdGhlIGRlcGxveWVkIGB0aW1lbG9ja2AgY29udHJhY3QncyBvd24gYWRkcmVzczogYHRpbWVsb2NrYCdzCmBleGVjdXRlKClgIHNlbGYtYXV0aG9yaXplcyBieSBwYXNzaW5nIGl0cyBvd24gYWRkcmVzcyBhcyB0aGUKYGFkbWluYCBhcmd1bWVudCwgc28gcmFpc2luZyBhIGZlZSBnZW51aW5lbHkgcmVxdWlyZXMgYSBwcm9wb3NhbAp0aGF0IHN1cnZpdmVkIHRoZSAyNGggZGVsYXksIHBlciBhZHIvMDAwMiBhbmQgYWRyLzAwMDcuIENhbGxhYmxlCm9uY2U7IHJlLXJ1bm5pbmcgaXQgYWZ0ZXIgYW4gYWRtaW4gaXMgYWxyZWFkeSBzZXQgaXMgcmVqZWN0ZWQgc28gYQpsYXRlciBjYWxsZXIgY2FuJ3Qgc2lsZW50bHkgdGFrZSBvdmVyIHRoZSBmZWUtc2V0dGluZyByb2xlLgAAAAAACmluaXRfYWRtaW4AAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAEAAAPpAAAAAgAAB9AAAAAJUmlza0Vycm9yAAAA",
        "AAAAAAAAAAAAAAAKdGllcl9zdGF0ZQAAAAAAAQAAAAAAAAAHYWNjb3VudAAAAAATAAAAAQAAB9AAAAAJVGllclN0YXRlAAAA",
        "AAAAAAAAAJBTaGlwcyBpbml0aWFsaXplZCB0byAwLiBHYXRlZCBiZWhpbmQgdGhlIHN0b3JlZCBhZG1pbiAoc2VlCmBpbml0X2FkbWluYCksIG5vdCBqdXN0IGFueSBhZGRyZXNzIHRoYXQgc2lnbnMgZm9yIGl0c2VsZiwgcGVyCmFkci8wMDAyIGFuZCBhZHIvMDAwNy4AAAALc2V0X2ZlZV9icHMAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAAtuZXdfZmVlX2JwcwAAAAAEAAAAAQAAA+kAAAACAAAH0AAAAAlSaXNrRXJyb3IAAAA=",
        "AAAAAAAAAP9QZXJtaXNzaW9ubGVzcyBjcmFuazogYW55b25lIGNhbiBjYWxsIHRoaXMgdG8gbW92ZSBzdGF0ZSB0byBhIG1vcmUKY29uc2VydmF0aXZlIGxldmVsIHdoZW4gcmVhbCwgb2JqZWN0aXZlbHktY2hlY2thYmxlIGNvbmRpdGlvbnMKd2FycmFudCBpdC4gTmV2ZXIgbW92ZXMgc3RhdGUgdG8gYSBsZXNzIGNvbnNlcnZhdGl2ZSBsZXZlbCDigJQgdGhhdCdzCmtlZXBlcl9hZHZhbmNlX3N0YXRlJ3Mgam9iLCBkZWxpYmVyYXRlbHkgZ2F0ZWQgdGlnaHRlci4AAAAADmNoZWNrX2FuZF90cmlwAAAAAAABAAAAAAAAAAdhY2NvdW50AAAAABMAAAABAAAH0AAAAAtTeXN0ZW1TdGF0ZQA=",
        "AAAAAAAAAKVUaGUgb24tY2hhaW4gZ3VhcmFudGVlIGV2ZXJ5IHBvbGljeSBkZXBlbmRzIG9uOiBuZXZlciBhbGxvdyBhCmRlcGxveW1lbnQgdGhhdCB3b3VsZCBwdXNoIHRvdGFsIFRpZXIgMSBjYXBpdGFsIGFib3ZlIHR2bF9jYXAsIGFuZApuZXZlciBhbGxvdyBvbmUgYXQgYWxsIGFib3ZlIE5PUk1BTC4AAAAAAAAOZGVwbG95X2FsbG93ZWQAAAAAAAIAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAGYW1vdW50AAAAAAALAAAAAQAAAAE=",
        "AAAAAAAAAiFIYW5kcyBvZmYgZmVlIGdvdmVybmFuY2UgdG8gYSBuZXcgYWRkcmVzcywgYHRpbWVsb2NrYCdzIG93bgpjb250cmFjdCBhZGRyZXNzIGluIHByb2R1Y3Rpb24uIE9ubHkgdGhlIGN1cnJlbnQgYWRtaW4gc2lnbnM7CmBuZXdfYWRtaW5gIGRvZXMgbm90LCBkZWxpYmVyYXRlbHk6IGEgY29udHJhY3QgYWRkcmVzcyBjYW4gbmV2ZXIKc2lnbiBhIHRyYW5zYWN0aW9uIHRoZSB3YXkgYW4gYWNjb3VudCBrZXkgY2FuLCBgcmVxdWlyZV9hdXRoKClgIGZvcgpvbmUgb25seSBldmVyIHN1Y2NlZWRzIHdoZW4gdGhhdCBjb250cmFjdCBpcyB0aGUgYWN0dWFsIGNhbGxlciBpbgp0aGUgZnJhbWUsIHNvIHJlcXVpcmluZyBpdHMgY29uc2VudCBoZXJlIGlzIGltcG9zc2libGUsIG5vdCBqdXN0CmluY29udmVuaWVudC4gVGhlIGN1cnJlbnQgYWRtaW4gY2hvb3NpbmcgdGhlIHN1Y2Nlc3NvciBpcyB0aGUgd2hvbGUKdHJ1c3QgYm91bmRhcnksIG1hdGNoaW5nIHRoZSBzdGFuZGFyZCBvd25lcnNoaXAtdHJhbnNmZXIgcGF0dGVybgp1c2VkIGFjcm9zcyB0aGUgZWNvc3lzdGVtLgAAAAAAAA50cmFuc2Zlcl9hZG1pbgAAAAAAAgAAAAAAAAANY3VycmVudF9hZG1pbgAAAAAAABMAAAAAAAAACW5ld19hZG1pbgAAAAAAABMAAAABAAAD6QAAAAIAAAfQAAAACVJpc2tFcnJvcgAAAA==",
        "AAAAAQAAAAAAAAAAAAAAEk1pcnJvcmVkUHJpY2VRdW90ZQAAAAAABQAAAAAAAAARY29uc2VydmF0aXZlX2hpZ2gAAAAAAAALAAAAAAAAABBjb25zZXJ2YXRpdmVfbG93AAAACwAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAZzdGF0dXMAAAAAB9AAAAAUTWlycm9yZWRPcmFjbGVTdGF0dXMAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAAAAAAAAAAAAAQc2V0X3RpZXIwX3RhcmdldAAAAAMAAAAAAAAAB2FjY291bnQAAAAAEwAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAAAAAApuZXdfdGFyZ2V0AAAAAAALAAAAAA==",
        "AAAAAwAAAPpNaXJyb3JzIG9yYWNsZS1yb3V0ZXIncyBPcmFjbGVTdGF0dXMuIENyb3NzLWNvbnRyYWN0IGNhbGxzIGFyZQpzdHJ1Y3R1cmFsIChYRFItbGV2ZWwpLCBzbyB0aGlzIGxvY2FsIG1pcnJvciBpcyBjb3JyZWN0IGFzIGxvbmcgYXMgdGhlCmZpZWxkIGxheW91dCBtYXRjaGVzIOKAlCB0aGUgc2FtZSBwcmluY2lwbGUgYXMgQmxlbmRSZXF1ZXN0IGFuZCB0aGUKcGVyLWZlZWQgQXNzZXQgaGFuZGxpbmcgaW4gb3JhY2xlLXJvdXRlciBpdHNlbGYuAAAAAAAAAAAAFE1pcnJvcmVkT3JhY2xlU3RhdHVzAAAABAAAAAAAAAAHSGVhbHRoeQAAAAAAAAAAAAAAAAdPbmVGZWVkAAAAAAEAAAAAAAAACERlZ3JhZGVkAAAAAgAAAAAAAAAISGFyZFN0b3AAAAAD",
        "AAAAAAAAAdhTYW1lIGFzIGBpbml0YCwgZXhjZXB0IGBwcmVlbXB0aXZlX3V0aWxfYnBzYC9gZnVsbF9kcmFpbl91dGlsX2Jwc2AKb24gYGNmZ2AgYXJlIG92ZXJ3cml0dGVuIGJ5IGBwcm9maWxlYCdzIHJlYWwgcHJlc2V0IHRocmVzaG9sZHMKcmF0aGVyIHRoYW4gdHJ1c3RlZCBmcm9tIHRoZSBjYWxsZXI7IGV2ZXJ5IG90aGVyIGZpZWxkIChhZGRyZXNzZXMsCmB0dmxfY2FwYCwgYGNyaXRpY2FsX2Zsb29yYCwgYHRpZXIwX2JvdW5kc19taW5gL2BtYXhgKSBpcyB1c2VkIGFzCmdpdmVuLCBzaW5jZSBub25lIG9mIGl0IGlzIGEgZnVuY3Rpb24gb2YgcmlzayBhcHBldGl0ZS4gTGV0cyBhCmNhbGxlciByZXVzZSB0aGUgZXhhY3Qgc2FtZSBgVGllckNvbmZpZ2Agc2hhcGUgYGluaXRgIHRha2VzLApuYW1pbmcgYSByaXNrIHByb2ZpbGUgaW5zdGVhZCBvZiB0eXBpbmcgYnBzIHZhbHVlcyBieSBoYW5kIGZvcgpqdXN0IHRob3NlIHR3byBmaWVsZHMuAAAAEWluaXRfd2l0aF9wcm9maWxlAAAAAAAABAAAAAAAAAAHYWNjb3VudAAAAAATAAAAAAAAAAdwcm9maWxlAAAAB9AAAAALUmlza1Byb2ZpbGUAAAAAAAAAAANjZmcAAAAH0AAAAApUaWVyQ29uZmlnAAAAAAAAAAAADHRpZXIwX3RhcmdldAAAAAsAAAAA",
        "AAAAAAAAAPtUaGUgb25seSBwYXRoIHRoYXQgbW92ZXMgc3RhdGUgdG8gYSBsZXNzIGNvbnNlcnZhdGl2ZSBsZXZlbCwgb3IKdHJpZ2dlcnMgUHJlZW1wdGl2ZURyYWluIHZpYSBrZWVwZXItYXR0ZXN0ZWQgdXRpbGl6YXRpb24gcmF0aGVyCnRoYW4gb3JhY2xlIHN0YXR1cy4gRXZlcnkgZG93bndhcmQgbW92ZSByZXF1aXJlcyB0aGUgb3JhY2xlIHRvIGJlCmdlbnVpbmVseSBIZWFsdGh5IHJpZ2h0IG5vdywgdmVyaWZpZWQgbGl2ZSwgbm90IGFzc2VydGVkLgAAAAAUa2VlcGVyX2FkdmFuY2Vfc3RhdGUAAAAEAAAAAAAAAAdhY2NvdW50AAAAABMAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAAAAAACdG8AAAAAB9AAAAALU3lzdGVtU3RhdGUAAAAAAAAAAA91dGlsaXphdGlvbl9icHMAAAAD6AAAAAQAAAAA",
        "AAAAAAAAA2ZSZWFsIGVuZm9yY2VtZW50IG9mIHRoZSBzYW1lIGd1YXJhbnRlZSBgZGVwbG95X2FsbG93ZWRgIGFkdmVydGlzZXMg4oCUCnRoaXMgdXNlZCB0byBiZSBwdXJlbHkgYWR2aXNvcnkgKG5vdGhpbmcgaGVyZSBjaGVja2VkIGB0dmxfY2FwYCBvcgpgU3lzdGVtU3RhdGVgIGF0IGFsbCwgYW55IGNhbGxlciB0aGF0IHNraXBwZWQgdGhlIGBkZXBsb3lfYWxsb3dlZGAKcHJlLWNoZWNrIGNvdWxkIHB1c2ggYSBwb3NpdGlvbiBhcmJpdHJhcmlseSBoaWdoKS4gUmVqZWN0cyBmb3IgcmVhbApub3csIHJldXNpbmcgYFJpc2tFcnJvcjo6Q2FwRXhjZWVkZWRgIGZvciBib3RoIHJlYXNvbnMKYGRlcGxveV9hbGxvd2VkYCBhbHJlYWR5IGNvbmZsYXRlcyBpbnRvIGEgc2luZ2xlIGJvb2wgKG92ZXItY2FwLCBvcgpzdGF0ZSBub3QgTm9ybWFsKSByYXRoZXIgdGhhbiBpbnZlbnRpbmcgYSBuZXcgdmFyaWFudCB0bwpkaXN0aW5ndWlzaCB0aGVtLgoKVGhlIGNhcCBjaGVjayBoZXJlIGlzIGRlbGliZXJhdGVseSAqbm90KiBgZGVwbG95X2FsbG93ZWRgJ3Mgb3duCmZvcm11bGE6IHRoaXMgZnVuY3Rpb24gKnNldHMqIChub3QgaW5jcmVtZW50cykgYHZlbnVlYCdzIHBvc2l0aW9uLApzbyB0aGUgcmVhbCBuZXcgdG90YWwgaXMgZXZlcnkgKm90aGVyKiB2ZW51ZSdzIGN1cnJlbnQgcG9zaXRpb24gcGx1cwpgYW1vdW50YCDigJQgcmV1c2luZyBgZGVwbG95X2FsbG93ZWRgJ3MgImN1cnJlbnQgdG90YWwgKyBhbW91bnQiCmZvcm11bGEgdW5tb2RpZmllZCB3b3VsZCBkb3VibGUtY291bnQgYHZlbnVlYCdzIG93biBzdGFsZSB2YWx1ZSBvbgpldmVyeSB1cGRhdGUgdG8gYW4gZXhpc3RpbmcgcG9zaXRpb24sIG5vdCBqdXN0IGEgZnJlc2ggZGVwbG95bWVudC4AAAAAABVyZWNvcmRfdGllcjFfcG9zaXRpb24AAAAAAAAEAAAAAAAAAAdhY2NvdW50AAAAABMAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAAAAAAFdmVudWUAAAAAAAATAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAA",
        "AAAAAgAAAApBc3NldCB0eXBlAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
        "AAAAAQAAAC9QcmljZSBkYXRhIGZvciBhbiBhc3NldCBhdCBhIHNwZWNpZmljIHRpbWVzdGFtcAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==" ]),
      options
    )
  }
  public readonly fromJSON = {
    init: this.txFromJSON<null>,
        state: this.txFromJSON<SystemState>,
        config: this.txFromJSON<TierConfig>,
        fee_bps: this.txFromJSON<u32>,
        init_admin: this.txFromJSON<Result<void>>,
        tier_state: this.txFromJSON<TierState>,
        set_fee_bps: this.txFromJSON<Result<void>>,
        check_and_trip: this.txFromJSON<SystemState>,
        deploy_allowed: this.txFromJSON<boolean>,
        transfer_admin: this.txFromJSON<Result<void>>,
        set_tier0_target: this.txFromJSON<null>,
        init_with_profile: this.txFromJSON<null>,
        keeper_advance_state: this.txFromJSON<null>,
        record_tier1_position: this.txFromJSON<null>
  }
}