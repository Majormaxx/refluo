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
