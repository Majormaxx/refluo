#![no_std]

//! RecallExecutor — smallest contract in the system, keep it under ~150 lines.
//! Security claim to property-test: funds move only venue -> vault, for all inputs.
//! Full spec: refluo-implementation-spec.md §3 (local, not in this repo).

use refluo_common::CommonError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecallConfig {
    pub max_recalls_per_window: u32,
    pub window: u64,
    pub min_interval_ledgers: u32,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
}

#[contract]
pub struct PolicyRecall;

#[contractimpl]
impl PolicyRecall {
    pub fn install(e: Env, account: Address, rule_id: u32, cfg: RecallConfig) {
        account.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::Config(account, rule_id), &cfg);
    }

    pub fn config(e: Env, account: Address, rule_id: u32) -> Result<RecallConfig, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Config(account, rule_id))
            .ok_or(CommonError::NotInitialized)
    }

    // can_enforce / enforce / uninstall: Phase 1. Ring-buffer rate limit +
    // dest == vault invariant, spec in refluo-implementation-spec.md §3.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn install_then_read_config_round_trips() {
        let e = Env::default();
        let contract_id = e.register(PolicyRecall, ());
        let client = PolicyRecallClient::new(&e, &contract_id);

        let account = Address::generate(&e);
        let cfg = RecallConfig {
            max_recalls_per_window: 6,
            window: 3600,
            min_interval_ledgers: 60,
        };

        e.mock_all_auths();
        client.install(&account, &1u32, &cfg);

        assert_eq!(client.config(&account, &1u32), cfg);
    }
}
