#![no_std]

//! OracleRouter — every other Refluo module reads price through here, never
//! feeds directly. Phase 2, BLOCKED on RedStone mainnet feed addresses /
//! decimals / heartbeat verification — see refluo-prd-unified.md §13 (local).
//! Full read-algorithm spec: refluo-implementation-spec.md §5 (local).

use refluo_common::{Asset, CommonError, PriceQuote};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetOracleConfig {
    pub primary_feed: Address,
    pub secondary_feed: Address,
    pub max_staleness_primary: u64,
    pub max_staleness_secondary: u64,
    pub twap_periods: u32,
    pub divergence_soft: u32,
    pub divergence_hard: u32,
    pub max_roc_per_update: u32,
}

#[contracttype]
pub enum DataKey {
    Config(Asset),
    LastAccepted,
}

#[contract]
pub struct OracleRouter;

#[contractimpl]
impl OracleRouter {
    /// Timelock-gated in Phase 2. No admin check yet at this scaffold stage.
    pub fn set_config(e: Env, asset: Asset, cfg: AssetOracleConfig) {
        assert!(
            cfg.twap_periods <= 64,
            "twap_periods exceeds history cap margin"
        );
        e.storage().persistent().set(&DataKey::Config(asset), &cfg);
    }

    pub fn config(e: Env, asset: Asset) -> Result<AssetOracleConfig, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Config(asset))
            .ok_or(CommonError::NotInitialized)
    }

    // get_price / check_and_trip: Phase 2, blocked on RedStone verification.
    // Do not write against guessed feed addresses or decimals.
}

#[allow(dead_code)]
type LastAccepted = Map<Asset, PriceQuote>;

#[cfg(test)]
mod test {
    use super::*;
    use refluo_common::OracleStatus;
    use soroban_sdk::{testutils::Address as _, Symbol};

    #[test]
    fn set_then_read_config_round_trips() {
        let e = Env::default();
        let contract_id = e.register(OracleRouter, ());
        let client = OracleRouterClient::new(&e, &contract_id);

        let cfg = AssetOracleConfig {
            primary_feed: Address::generate(&e),
            secondary_feed: Address::generate(&e),
            max_staleness_primary: 600,
            max_staleness_secondary: 600,
            twap_periods: 6,
            divergence_soft: 200,
            divergence_hard: 500,
            max_roc_per_update: 1000,
        };
        let asset = Asset::Other(Symbol::new(&e, "USDC"));

        client.set_config(&asset, &cfg);
        assert_eq!(client.config(&asset), cfg);
    }

    #[test]
    #[should_panic(expected = "twap_periods exceeds history cap margin")]
    fn twap_periods_over_cap_margin_panics() {
        let e = Env::default();
        let contract_id = e.register(OracleRouter, ());
        let client = OracleRouterClient::new(&e, &contract_id);

        let cfg = AssetOracleConfig {
            primary_feed: Address::generate(&e),
            secondary_feed: Address::generate(&e),
            max_staleness_primary: 600,
            max_staleness_secondary: 600,
            twap_periods: 65,
            divergence_soft: 200,
            divergence_hard: 500,
            max_roc_per_update: 1000,
        };
        client.set_config(&Asset::Other(Symbol::new(&e, "USDC")), &cfg);
    }

    #[test]
    fn oracle_status_default_ordering_sane() {
        assert!((OracleStatus::Healthy as u32) < (OracleStatus::HardStop as u32));
    }
}
