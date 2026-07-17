#![no_std]

//! SessionScope — agent hot-key hygiene. Wraps the agent key's context rules
//! with expiry, per-tx/epoch caps, and destination-class allowlist.
//! Full spec: refluo-implementation-spec.md §4 (local, not in this repo).

use refluo_common::CommonError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DestClass {
    Facilitator(Address),
    MppSession(Address),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionConfig {
    pub expiry_ledger: u32,
    pub per_tx_cap: i128,
    pub epoch_cap: i128,
    pub epoch_length: u64,
    pub dest_classes: Vec<DestClass>,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
}

#[contract]
pub struct PolicySession;

#[contractimpl]
impl PolicySession {
    pub fn install(e: Env, account: Address, rule_id: u32, cfg: SessionConfig) {
        account.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::Config(account, rule_id), &cfg);
    }

    pub fn config(e: Env, account: Address, rule_id: u32) -> Result<SessionConfig, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Config(account, rule_id))
            .ok_or(CommonError::NotInitialized)
    }

    // can_enforce / enforce / uninstall: Phase 1. Expiry check first (cheapest),
    // then dest-class match, then caps. Rotation unhappy-path test required:
    // old rule uninstalled while a signed-but-unsubmitted auth entry exists.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn install_then_read_config_round_trips() {
        let e = Env::default();
        let contract_id = e.register(PolicySession, ());
        let client = PolicySessionClient::new(&e, &contract_id);

        let account = Address::generate(&e);
        let facilitator = Address::generate(&e);
        let cfg = SessionConfig {
            expiry_ledger: 1_000_000,
            per_tx_cap: 1_000_000_000,
            epoch_cap: 10_000_000_000,
            epoch_length: 86400,
            dest_classes: Vec::from_array(&e, [DestClass::Facilitator(facilitator)]),
        };

        e.mock_all_auths();
        client.install(&account, &1u32, &cfg);

        assert_eq!(client.config(&account, &1u32), cfg);
    }
}
