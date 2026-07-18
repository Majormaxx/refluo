#![no_std]

//! HealthMonitor — a pause switch anyone on the guardian list can flip,
//! that clears itself if nobody acts within the configured window, and
//! that only the configured admin can reopen early. Recovery after an
//! oracle-triggered trip requires a run of consecutive healthy readings,
//! not just one, so it can't flap. Modeled on Lido's GateSeal. Full spec
//! tracked internally, not in this repo.
//!
//! `pause`/`resume_early` are real now (not stubs): RiskEngine's Paused
//! transition cross-calls `status()`, and a status() that could only ever
//! return false would make that transition untestable in spirit, even
//! though the code compiles. `extend`/`tick_recovery`/`check_and_trip`
//! remain genuinely unbuilt, stated as such, not faked.

use refluo_common::CommonError;
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, panic_with_error, Address, Env, Vec,
};

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
    Admin,
    Pause,
    Guardians,
}

const MAX_PAUSE_DURATION: u64 = 72 * 3600;
#[allow(dead_code)]
const MAX_EXTENSIONS: u32 = 2;

#[contractevent]
#[derive(Clone, Debug)]
pub struct Paused {
    #[topic]
    pub trigger: PauseTrigger,
    pub pause_expiry: u64,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct Resumed {
    #[topic]
    pub early: bool,
}

#[contract]
pub struct HealthMonitor;

#[contractimpl]
impl HealthMonitor {
    pub fn init_guardians(e: Env, admin: Address, guardians: Vec<Address>) {
        admin.require_auth();
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::Guardians, &guardians);
    }

    pub fn guardians(e: Env) -> Result<Vec<Address>, CommonError> {
        e.storage()
            .instance()
            .get(&DataKey::Guardians)
            .ok_or(CommonError::NotInitialized)
    }

    /// status() computes paused && now < pause_expiry lazily — no keeper
    /// needed to un-pause, the ledger clock does it.
    pub fn status(e: Env) -> bool {
        let state: Option<PauseState> = e.storage().instance().get(&DataKey::Pause);
        match state {
            Some(s) => s.paused && e.ledger().timestamp() < s.pause_expiry,
            None => false,
        }
    }

    /// Any guardian in the configured set can trigger this. Cheap and
    /// broad on purpose: false positives only block risk-increasing
    /// actions, and the 72h auto-expiry bounds the cost of a bad trigger.
    pub fn pause(e: Env, guardian: Address) {
        guardian.require_auth();

        let guardians: Vec<Address> = e
            .storage()
            .instance()
            .get(&DataKey::Guardians)
            .unwrap_or_else(|| panic_with_error!(e, CommonError::NotInitialized));
        if !guardians.contains(&guardian) {
            panic_with_error!(e, CommonError::Unauthorized);
        }

        let now = e.ledger().timestamp();
        let expiry = now + MAX_PAUSE_DURATION;
        let state = PauseState {
            paused: true,
            pause_expiry: expiry,
            trigger: PauseTrigger::Guardian,
            extensions_used: 0,
            healthy_streak: 0,
        };
        e.storage().instance().set(&DataKey::Pause, &state);
        Paused {
            trigger: PauseTrigger::Guardian,
            pause_expiry: expiry,
        }
        .publish(&e);
    }

    /// Only the configured admin (in production, the vault's own smart
    /// account, so this composes with its own multisig auth) can resume
    /// before the 72h auto-expiry.
    pub fn resume_early(e: Env, admin: Address) {
        admin.require_auth();

        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(e, CommonError::NotInitialized));
        if admin != stored_admin {
            panic_with_error!(e, CommonError::Unauthorized);
        }

        let mut state: PauseState = e
            .storage()
            .instance()
            .get(&DataKey::Pause)
            .unwrap_or_else(|| panic_with_error!(e, CommonError::NotInitialized));
        state.paused = false;
        e.storage().instance().set(&DataKey::Pause, &state);
        Resumed { early: true }.publish(&e);
    }

    // extend / check_and_trip / tick_recovery: not yet implemented.
    // Hysteresis constants (trip 5%, reset 1%) must never be made equal.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

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

    #[test]
    fn guardian_can_pause_and_status_reflects_it() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let guardian = Address::generate(&e);
        e.mock_all_auths();
        client.init_guardians(&admin, &Vec::from_array(&e, [guardian.clone()]));

        assert!(!client.status());
        client.pause(&guardian);
        assert!(client.status());
    }

    #[test]
    fn non_guardian_cannot_pause() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let guardian = Address::generate(&e);
        let outsider = Address::generate(&e);
        e.mock_all_auths();
        client.init_guardians(&admin, &Vec::from_array(&e, [guardian]));

        let result = client.try_pause(&outsider);
        assert!(result.is_err());
    }

    #[test]
    fn pause_auto_expires_after_72_hours() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let guardian = Address::generate(&e);
        e.mock_all_auths();
        client.init_guardians(&admin, &Vec::from_array(&e, [guardian.clone()]));
        client.pause(&guardian);
        assert!(client.status());

        e.ledger()
            .with_mut(|l| l.timestamp += MAX_PAUSE_DURATION + 1);
        assert!(
            !client.status(),
            "must lazily clear with no keeper involved"
        );
    }

    #[test]
    fn admin_can_resume_early() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let guardian = Address::generate(&e);
        e.mock_all_auths();
        client.init_guardians(&admin, &Vec::from_array(&e, [guardian.clone()]));
        client.pause(&guardian);
        assert!(client.status());

        client.resume_early(&admin);
        assert!(!client.status());
    }

    #[test]
    fn non_admin_cannot_resume_early() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        let contract_id = e.register(HealthMonitor, ());
        let client = HealthMonitorClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        let guardian = Address::generate(&e);
        let outsider = Address::generate(&e);
        e.mock_all_auths();
        client.init_guardians(&admin, &Vec::from_array(&e, [guardian.clone()]));
        client.pause(&guardian);

        let result = client.try_resume_early(&outsider);
        assert!(result.is_err());
        assert!(
            client.status(),
            "must remain paused after a rejected resume attempt"
        );
    }
}
