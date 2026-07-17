#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, Symbol};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SystemState {
    Normal = 0,
    PreemptiveDrain = 1,
    Emergency = 2,
    Paused = 3,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleStatus {
    Healthy = 0,
    OneFeed = 1,
    Degraded = 2,
    HardStop = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceQuote {
    /// Scaled to router decimals (14, matching Reflector).
    pub price: i128,
    pub timestamp: u64,
    pub status: OracleStatus,
    /// min(feeds) for collateral-side valuation.
    pub conservative_low: i128,
    /// max(feeds) for liability-side valuation.
    pub conservative_high: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CommonError {
    NotInitialized = 1,
    Unauthorized = 2,
    Paused = 3,
    StaleData = 4,
    CapExceeded = 5,
    RateLimited = 6,
    BadState = 7,
}

/// Mirrors Blend V2's `Request` struct. NOT a dependency on Blend's crate
/// (unpublished on crates.io) — Soroban contracttype XDR encoding is
/// structural (field order, not Rust type identity), so a local mirror with
/// matching layout decodes real Blend calldata correctly. Verified against
/// blend-capital/blend-contracts-v2 tag v2.0.0, pool/src/pool/actions.rs:
/// request_type values below are confirmed from that source, not guessed.
/// Shared by policy-venue and policy-recall, which both decode Blend
/// `submit()` calldata.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlendRequest {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

pub const BLEND_SUPPLY: u32 = 0;
pub const BLEND_WITHDRAW: u32 = 1;
pub const BLEND_SUPPLY_COLLATERAL: u32 = 2;
pub const BLEND_WITHDRAW_COLLATERAL: u32 = 3;
// 4 Borrow, 5 Repay, 6-9 auction/administrative request types: intentionally
// have no named constants here. Every consumer matches only the four names
// above and rejects everything else via a wildcard arm, so an unnamed type
// can never accidentally fall through as allowed.

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn system_state_variants_are_distinct() {
        assert_ne!(SystemState::Normal as u32, SystemState::Paused as u32);
    }

    #[test]
    fn oracle_status_variants_are_distinct() {
        assert_ne!(OracleStatus::Healthy as u32, OracleStatus::HardStop as u32);
    }
}
