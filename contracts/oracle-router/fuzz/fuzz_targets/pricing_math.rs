#![no_main]

//! Fuzzes OracleRouter's pure pricing math (rescale, divergence_bps,
//! roc_ok) against the full i128/u32 domain, going beyond the handful of
//! values property tests happened to pick. The PRD calls for cargo-fuzz
//! on OracleRouter's read algorithm specifically; these three functions
//! are the arithmetic core of that algorithm, exercised here without
//! needing a live Env since none of them touch storage or cross-contract
//! calls. See adr/0009.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use refluo_oracle_router::{divergence_bps, rescale, roc_ok, OracleStatus, PriceQuote};

#[derive(Debug, Arbitrary)]
struct RescaleInput {
    price: i128,
    from_decimals: u8,
    to_decimals: u8,
}

#[derive(Debug, Arbitrary)]
struct RocInput {
    candidate: i128,
    last_price: i128,
    max_roc_per_update: u32,
    have_last_accepted: bool,
}

#[derive(Debug, Arbitrary)]
enum FuzzOp {
    Rescale(RescaleInput),
    Divergence(i128, i128),
    Roc(RocInput),
}

fuzz_target!(|op: FuzzOp| {
    match op {
        FuzzOp::Rescale(input) => {
            // Must never panic for any decimals in the range real feeds
            // use (Reflector 14, RedStone default 8, ROUTER_DECIMALS 14);
            // fuzzing the full u8 range catches overflow a
            // narrower-by-hand test would miss.
            let _ = rescale(
                input.price,
                input.from_decimals as u32,
                input.to_decimals as u32,
            );
            // Rescaling to the same decimals must always be the identity,
            // regardless of price, this is the one exact invariant that
            // holds with no rounding involved.
            let same = rescale(
                input.price,
                input.from_decimals as u32,
                input.from_decimals as u32,
            );
            assert_eq!(
                same, input.price,
                "rescale to identical decimals must not change price"
            );
        }
        FuzzOp::Divergence(p, s) => {
            let d1 = divergence_bps(p, s);
            let d2 = divergence_bps(s, p);
            assert_eq!(
                d1, d2,
                "divergence_bps must be symmetric: divergence({p},{s}) != divergence({s},{p})"
            );
            if p <= 0 || s <= 0 {
                assert_eq!(
                    d1,
                    u32::MAX,
                    "non-positive input must report max divergence, never a false Healthy signal"
                );
            }
        }
        FuzzOp::Roc(input) => {
            let last = input.have_last_accepted.then_some(PriceQuote {
                price: input.last_price,
                timestamp: 0,
                status: OracleStatus::Healthy,
                conservative_low: input.last_price,
                conservative_high: input.last_price,
            });
            let result = roc_ok(input.max_roc_per_update, input.candidate, last.as_ref());
            if last.is_none() {
                assert!(
                    result,
                    "with no prior accepted price, the first write must always pass the ROC clamp"
                );
            }
        }
    }
});
