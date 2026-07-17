#![no_std]

//! RiskEngine — SystemState + tier bookkeeping. Bounds-checker only: the one
//! guarantee that matters is provable on-chain — no deployment above NORMAL.
//! Also owns the fee-recipient hook (refluo-prd-unified.md §12.1, local):
//! fee_bps lives in storage behind set_fee_bps(), never a compiled constant,
//! so it can move later without a contract migration. Ships at 0% here.
//! Full spec: refluo-implementation-spec.md §8 (local, not in this repo).

use refluo_common::{CommonError, SystemState};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

/// Hardcoded ceiling, unchangeable by any admin or timelock action —
/// a number a customer can verify on-chain, not a promise. 20% matches
/// Yearn's historical performance-fee ceiling (refluo-prd-unified.md §12.1).
const MAX_FEE_BPS: u32 = 2000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TierState {
    pub tier0_target: i128,
    pub tier0_bounds_min: i128,
    pub tier0_bounds_max: i128,
    pub tvl_cap: i128,
}

#[contracttype]
pub enum DataKey {
    State(Address),
    Tier(Address),
    FeeBps,
    FeeRecipient,
}

#[contract]
pub struct RiskEngine;

#[contractimpl]
impl RiskEngine {
    pub fn init(e: Env, account: Address, tier: TierState) {
        account.require_auth();
        e.storage()
            .persistent()
            .set(&DataKey::State(account.clone()), &SystemState::Normal);
        e.storage().persistent().set(&DataKey::Tier(account), &tier);
    }

    pub fn state(e: Env, account: Address) -> Result<SystemState, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::State(account))
            .ok_or(CommonError::NotInitialized)
    }

    pub fn tier_state(e: Env, account: Address) -> Result<TierState, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Tier(account))
            .ok_or(CommonError::NotInitialized)
    }

    /// Ships initialized to 0. Timelock-gated wiring is Phase 4 — this
    /// scaffold only enforces the hardcoded ceiling, per §12.1.
    pub fn set_fee_bps(e: Env, admin: Address, new_fee_bps: u32) -> Result<(), CommonError> {
        admin.require_auth();
        if new_fee_bps > MAX_FEE_BPS {
            return Err(CommonError::CapExceeded);
        }
        e.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        Ok(())
    }

    pub fn fee_bps(e: Env) -> u32 {
        e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }

    // set_tier0_target / advance_state: Phase 3. Transitions validated
    // on-chain per refluo-implementation-spec.md §8 — no deployment above
    // NORMAL is the invariant every other contract in the system depends on.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn sample_tier() -> TierState {
        TierState {
            tier0_target: 10_000_000_000,
            tier0_bounds_min: 5_000_000_000,
            tier0_bounds_max: 20_000_000_000,
            tvl_cap: 100_000_000_000,
        }
    }

    #[test]
    fn init_defaults_to_normal_state() {
        let e = Env::default();
        let contract_id = e.register(RiskEngine, ());
        let client = RiskEngineClient::new(&e, &contract_id);

        let account = Address::generate(&e);
        let tier = sample_tier();

        e.mock_all_auths();
        client.init(&account, &tier);

        assert_eq!(client.state(&account), SystemState::Normal);
        assert_eq!(client.tier_state(&account), tier);
    }

    #[test]
    fn fee_bps_defaults_to_zero() {
        let e = Env::default();
        let contract_id = e.register(RiskEngine, ());
        let client = RiskEngineClient::new(&e, &contract_id);
        assert_eq!(client.fee_bps(), 0);
    }

    #[test]
    fn set_fee_bps_within_ceiling_succeeds() {
        let e = Env::default();
        let contract_id = e.register(RiskEngine, ());
        let client = RiskEngineClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        e.mock_all_auths();
        client.set_fee_bps(&admin, &1500);

        assert_eq!(client.fee_bps(), 1500);
    }

    #[test]
    fn set_fee_bps_above_ceiling_fails() {
        let e = Env::default();
        let contract_id = e.register(RiskEngine, ());
        let client = RiskEngineClient::new(&e, &contract_id);

        let admin = Address::generate(&e);
        e.mock_all_auths();
        let result = client.try_set_fee_bps(&admin, &(MAX_FEE_BPS + 1));

        assert!(result.is_err());
        assert_eq!(client.fee_bps(), 0);
    }
}
