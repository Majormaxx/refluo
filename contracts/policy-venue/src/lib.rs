#![no_std]

//! YieldVenueAllowlist — the most dangerous decoder in the system, fuzz it hardest.
//! Full enforce() spec: refluo-implementation-spec.md §2 (local, not in this repo).

use refluo_common::CommonError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VenueConfig {
    pub venues: Vec<Address>,
    pub per_call_cap: i128,
    pub epoch_cap: i128,
    pub epoch_length: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EpochSpend {
    pub spent: i128,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
    EpochSpend(Address, u32, u64),
    LastWriteEpoch(Address, u32),
}

#[contract]
pub struct PolicyVenue;

#[contractimpl]
impl PolicyVenue {
    /// OZ Policy lifecycle: install. Stores VenueConfig keyed by (account, rule_id).
    pub fn install(e: Env, account: Address, rule_id: u32, cfg: VenueConfig) {
        account.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::Config(account, rule_id), &cfg);
    }

    pub fn config(e: Env, account: Address, rule_id: u32) -> Result<VenueConfig, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Config(account, rule_id))
            .ok_or(CommonError::NotInitialized)
    }

    // can_enforce / enforce / uninstall: Phase 1 work, spec in
    // refluo-implementation-spec.md §2. Decoding Blend's submit() request
    // vector and the epoch fail-closed counter logic land here.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn install_then_read_config_round_trips() {
        let e = Env::default();
        let contract_id = e.register(PolicyVenue, ());
        let client = PolicyVenueClient::new(&e, &contract_id);

        let account = Address::generate(&e);
        let venue = Address::generate(&e);
        let cfg = VenueConfig {
            venues: Vec::from_array(&e, [venue]),
            per_call_cap: 100_000_000_000,
            epoch_cap: 500_000_000_000,
            epoch_length: 86400,
        };

        e.mock_all_auths();
        client.install(&account, &1u32, &cfg);

        let read = client.config(&account, &1u32);
        assert_eq!(read, cfg);
    }
}
