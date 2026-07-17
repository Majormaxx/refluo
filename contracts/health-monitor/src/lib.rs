#![no_std]

//! HealthMonitor — gate-seal pause. Cheap/broad trigger, lazy auto-expiry,
//! narrow resume, hysteresis-gated auto-recovery. Modeled on Lido's
//! GateSeal. Full spec tracked internally, not in this repo.

use refluo_common::CommonError;
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PauseTrigger {
    Guardian,
    OracleAuto,
    Behavioral,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseState {
    pub paused: bool,
    pub pause_expiry: u64,
    pub trigger: PauseTrigger,
    pub extensions_used: u32,
    pub healthy_streak: u32,
}

#[contracttype]
pub enum DataKey {
    Pause,
    Guardians,
}

#[allow(dead_code)]
const MAX_PAUSE_DURATION: u64 = 72 * 3600;
#[allow(dead_code)]
const MAX_EXTENSIONS: u32 = 2;

#[contract]
pub struct HealthMonitor;

#[contractimpl]
impl HealthMonitor {
    pub fn init_guardians(e: Env, admin: Address, guardians: Vec<Address>) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Guardians, &guardians);
    }

    pub fn guardians(e: Env) -> Result<Vec<Address>, CommonError> {
        e.storage()
            .instance()
            .get(&DataKey::Guardians)
            .ok_or(CommonError::NotInitialized)
    }

    /// status() computes paused && now < pause_expiry lazily — no keeper
    /// needed to un-pause, the ledger clock does it. Full trip/resume logic
    /// not yet implemented.
    pub fn status(e: Env) -> bool {
        let state: Option<PauseState> = e.storage().instance().get(&DataKey::Pause);
        match state {
            Some(s) => s.paused && e.ledger().timestamp() < s.pause_expiry,
            None => false,
        }
    }

    // pause / resume_early / extend / check_and_trip / tick_recovery: not
    // yet implemented. Hysteresis constants (trip 5%, reset 1%) must never
    // be made equal.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn status_defaults_to_unpaused_before_init() {
        let e = Env::default();
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);
        assert!(!client.status());
    }

    #[test]
    fn init_guardians_then_read_round_trips() {
        let e = Env::default();
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let g1 = Address::generate(&e);
        let g2 = Address::generate(&e);
        let guardians = Vec::from_array(&e, [g1, g2]);

        e.mock_all_auths();
        client.init_guardians(&admin, &guardians);

        assert_eq!(client.guardians(), guardians);
    }
}
