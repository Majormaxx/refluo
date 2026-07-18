#![no_std]

//! MockPriceFeed: a real, deployed contract implementing sep-40-oracle's
//! `PriceFeedTrait`, admin-settable so it can stand in for an
//! attacker-controlled secondary feed during the live YieldBlox drill
//! (adr/0009). A real testnet feed can't be made to lie on demand;
//! this is the controlled stand-in for the one input a real attack
//! actually manipulates. `PriceFeedClient` (sep-40-oracle, the same
//! client oracle-router calls real Reflector/RedStone feeds with) works
//! against this unmodified: Soroban contract calls are structural, not
//! nominal, so implementing the real trait is what makes this a real
//! cross-contract call, not a stub standing in for one. See adr/0005
//! for the structural-compatibility precedent this reuses.

use sep_40_oracle::{Asset, PriceData, PriceFeedTrait};
use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, Address, Env, Vec};

#[contracttype]
pub enum DataKey {
    Admin,
    Price,
}

#[soroban_sdk::contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MockFeedError {
    Unauthorized = 1,
}

#[contract]
pub struct MockPriceFeed;

#[contractimpl]
impl MockPriceFeed {
    pub fn init(e: Env, admin: Address, initial_price: i128, timestamp: u64) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(
            &DataKey::Price,
            &PriceData {
                price: initial_price,
                timestamp,
            },
        );
    }

    /// The one function this whole contract exists for: let an admin
    /// impersonate a compromised feed reporting an arbitrary price, on
    /// demand, against a real deployed contract a real OracleRouter
    /// cross-calls into.
    pub fn set_price(e: Env, admin: Address, price: i128, timestamp: u64) {
        admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(e, MockFeedError::Unauthorized));
        if admin != stored_admin {
            panic_with_error!(e, MockFeedError::Unauthorized);
        }
        e.storage()
            .instance()
            .set(&DataKey::Price, &PriceData { price, timestamp });
    }
}

#[contractimpl]
impl PriceFeedTrait for MockPriceFeed {
    fn base(_e: Env) -> Asset {
        Asset::Other(soroban_sdk::Symbol::new(&_e, "USD"))
    }

    fn assets(e: Env) -> Vec<Asset> {
        Vec::new(&e)
    }

    fn decimals(_e: Env) -> u32 {
        14
    }

    fn resolution(_e: Env) -> u32 {
        300
    }

    fn price(e: Env, _asset: Asset, _timestamp: u64) -> Option<PriceData> {
        e.storage().instance().get(&DataKey::Price)
    }

    fn prices(e: Env, _asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let pd: PriceData = e.storage().instance().get(&DataKey::Price)?;
        let mut out = Vec::new(&e);
        for _ in 0..records.min(1) {
            out.push_back(pd.clone());
        }
        Some(out)
    }

    fn lastprice(e: Env, _asset: Asset) -> Option<PriceData> {
        e.storage().instance().get(&DataKey::Price)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn set_price_then_lastprice_round_trips() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(MockPriceFeed, ());
        let client = MockPriceFeedClient::new(&e, &contract_id);
        let admin = Address::generate(&e);
        let asset = Asset::Other(soroban_sdk::Symbol::new(&e, "XLM"));

        client.init(&admin, &100_00000000000, &1000);
        let pd = client.lastprice(&asset).unwrap();
        assert_eq!(pd.price, 100_00000000000);

        client.set_price(&admin, &10_000_000_000_000, &2000);
        let spiked = client.lastprice(&asset).unwrap();
        assert_eq!(
            spiked.price, 10_000_000_000_000,
            "must actually report the spiked price, not a cached one"
        );
    }

    #[test]
    fn set_price_from_non_admin_rejected() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(MockPriceFeed, ());
        let client = MockPriceFeedClient::new(&e, &contract_id);
        let admin = Address::generate(&e);
        let outsider = Address::generate(&e);

        client.init(&admin, &100, &1000);
        let result = client.try_set_price(&outsider, &999, &2000);
        assert!(result.is_err());
    }
}
