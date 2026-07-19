#![no_std]

//! RiskEngine — SystemState + tier bookkeeping. Bounds-checker only: the
//! one guarantee that matters is provable on-chain, no deployment above
//! NORMAL. Also owns the fee-recipient hook (see adr/0002).
//!
//! Every upward (more conservative) transition is read from a real
//! contract, never trusted from a caller: oracle status via a real
//! cross-contract call to OracleRouter, pause status via a real
//! cross-contract call to HealthMonitor, the critical-floor check via a
//! real on-chain USDC balance read. Venue utilization is the one
//! deliberately keeper-attested input (see adr/0006) — that's genuinely
//! off-chain data (Blend reserve state via RPC), not a shortcut.
//!
//! Isolated on its own soroban-sdk version to share sep-40-oracle's Asset
//! type directly with OracleRouter — see adr/0006 (mirrors adr/0005).

use sep_40_oracle::Asset;
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token::TokenClient, Address, Env, Map,
};

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SystemState {
    Normal = 0,
    PreemptiveDrain = 1,
    Emergency = 2,
    Paused = 3,
}

/// Mirrors oracle-router's OracleStatus. Cross-contract calls are
/// structural (XDR-level), so this local mirror is correct as long as the
/// field layout matches — the same principle as BlendRequest and the
/// per-feed Asset handling in oracle-router itself.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MirroredOracleStatus {
    Healthy = 0,
    OneFeed = 1,
    Degraded = 2,
    HardStop = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MirroredPriceQuote {
    pub price: i128,
    pub timestamp: u64,
    pub status: MirroredOracleStatus,
    pub conservative_low: i128,
    pub conservative_high: i128,
}

// The trait itself is never called directly, only its generated Client —
// same pattern stellar-accounts uses for PolicyClientInterface.
#[allow(dead_code)]
#[contractclient(name = "OracleRouterClient")]
trait OracleRouterInterface {
    fn get_price(e: Env, asset: Asset) -> MirroredPriceQuote;
}

#[allow(dead_code)]
#[contractclient(name = "HealthMonitorClient")]
trait HealthMonitorInterface {
    fn status(e: Env) -> bool;
}

#[contracttype]
#[derive(Clone)]
pub struct TierConfig {
    pub oracle_router: Address,
    /// Which asset's price status gates transitions — the vault's Tier 0
    /// reserve asset (USDC).
    pub oracle_asset: Asset,
    pub health_monitor: Address,
    pub usdc_token: Address,
    pub keeper: Address,
    pub tier0_bounds_min: i128,
    pub tier0_bounds_max: i128,
    /// Emergency trigger: real on-chain Tier 0 balance below this.
    pub critical_floor: i128,
    /// Total Tier 1 capital cap across all venues.
    pub tvl_cap: i128,
    /// Keeper-attested utilization (bps) at or above this triggers
    /// PreemptiveDrain via the utilization path.
    pub preemptive_util_bps: u32,
    /// Keeper-attested utilization (bps) at or above this triggers a full
    /// drain (Emergency) via the utilization path, not just PreemptiveDrain.
    /// Must be strictly greater than `preemptive_util_bps`, checked at
    /// `init()`.
    pub full_drain_util_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TierState {
    pub tier0_target: i128,
    pub tier1_positions: Map<Address, i128>,
}

#[contracttype]
pub enum DataKey {
    Config(Address),
    State(Address),
    Tier(Address),
    FeeBps,
    Admin,
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RiskError {
    NotInitialized = 1,
    Unauthorized = 2,
    CapExceeded = 3,
    InvalidTransition = 4,
    InvalidConfig = 5,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct StateChanged {
    #[topic]
    pub account: Address,
    pub from: SystemState,
    pub to: SystemState,
}

/// Hardcoded ceiling, unchangeable by any admin or timelock action, a
/// number a customer can verify on-chain, not a promise. 20% matches
/// Yearn's historical performance-fee ceiling (adr/0002).
const MAX_FEE_BPS: u32 = 2000;

#[contract]
pub struct RiskEngine;

#[contractimpl]
impl RiskEngine {
    pub fn init(e: Env, account: Address, cfg: TierConfig, tier0_target: i128) {
        account.require_auth();
        if cfg.tier0_bounds_min > cfg.tier0_bounds_max
            || tier0_target < cfg.tier0_bounds_min
            || tier0_target > cfg.tier0_bounds_max
            || cfg.tvl_cap <= 0
            || cfg.critical_floor < 0
            || cfg.full_drain_util_bps <= cfg.preemptive_util_bps
        {
            panic_with_error!(e, RiskError::InvalidConfig);
        }
        e.storage()
            .persistent()
            .set(&DataKey::Config(account.clone()), &cfg);
        e.storage()
            .persistent()
            .set(&DataKey::State(account.clone()), &SystemState::Normal);
        let tier = TierState {
            tier0_target,
            tier1_positions: Map::new(&e),
        };
        e.storage().persistent().set(&DataKey::Tier(account), &tier);
    }

    pub fn config(e: Env, account: Address) -> TierConfig {
        e.storage()
            .persistent()
            .get(&DataKey::Config(account))
            .unwrap_or_else(|| panic_with_error!(e, RiskError::NotInitialized))
    }

    pub fn state(e: Env, account: Address) -> SystemState {
        e.storage()
            .persistent()
            .get(&DataKey::State(account))
            .unwrap_or_else(|| panic_with_error!(e, RiskError::NotInitialized))
    }

    pub fn tier_state(e: Env, account: Address) -> TierState {
        e.storage()
            .persistent()
            .get(&DataKey::Tier(account))
            .unwrap_or_else(|| panic_with_error!(e, RiskError::NotInitialized))
    }

    /// The on-chain guarantee every policy depends on: never allow a
    /// deployment that would push total Tier 1 capital above tvl_cap, and
    /// never allow one at all above NORMAL.
    pub fn deploy_allowed(e: Env, account: Address, amount: i128) -> bool {
        let state: SystemState = Self::state(e.clone(), account.clone());
        if state != SystemState::Normal {
            return false;
        }
        let tier = Self::tier_state(e.clone(), account.clone());
        let cfg = Self::config(e, account);
        let total: i128 = tier.tier1_positions.values().iter().sum();
        total.saturating_add(amount) <= cfg.tvl_cap
    }

    pub fn set_tier0_target(e: Env, account: Address, keeper: Address, new_target: i128) {
        keeper.require_auth();
        let cfg = Self::config(e.clone(), account.clone());
        if keeper != cfg.keeper {
            panic_with_error!(e, RiskError::Unauthorized);
        }
        let clamped = new_target.clamp(cfg.tier0_bounds_min, cfg.tier0_bounds_max);
        let mut tier = Self::tier_state(e.clone(), account.clone());
        tier.tier0_target = clamped;
        e.storage().persistent().set(&DataKey::Tier(account), &tier);
    }

    pub fn record_tier1_position(
        e: Env,
        account: Address,
        keeper: Address,
        venue: Address,
        amount: i128,
    ) {
        keeper.require_auth();
        let cfg = Self::config(e.clone(), account.clone());
        if keeper != cfg.keeper {
            panic_with_error!(e, RiskError::Unauthorized);
        }
        let mut tier = Self::tier_state(e.clone(), account.clone());
        tier.tier1_positions.set(venue, amount);
        e.storage().persistent().set(&DataKey::Tier(account), &tier);
    }

    /// Permissionless crank: anyone can call this to move state to a more
    /// conservative level when real, objectively-checkable conditions
    /// warrant it. Never moves state to a less conservative level — that's
    /// keeper_advance_state's job, deliberately gated tighter.
    pub fn check_and_trip(e: Env, account: Address) -> SystemState {
        let current = Self::state(e.clone(), account.clone());
        let cfg = Self::config(e.clone(), account.clone());

        let paused = HealthMonitorClient::new(&e, &cfg.health_monitor).status();
        let oracle = OracleRouterClient::new(&e, &cfg.oracle_router).get_price(&cfg.oracle_asset);
        let tier0_balance = TokenClient::new(&e, &cfg.usdc_token).balance(&account);

        let target = if paused {
            SystemState::Paused
        } else if matches!(
            oracle.status,
            MirroredOracleStatus::Degraded | MirroredOracleStatus::HardStop
        ) || tier0_balance < cfg.critical_floor
        {
            SystemState::Emergency
        } else if matches!(oracle.status, MirroredOracleStatus::OneFeed) {
            SystemState::PreemptiveDrain
        } else {
            current
        };

        if target > current {
            e.storage()
                .persistent()
                .set(&DataKey::State(account.clone()), &target);
            StateChanged {
                account,
                from: current,
                to: target,
            }
            .publish(&e);
            target
        } else {
            current
        }
    }

    /// The only path that moves state to a less conservative level, or
    /// triggers PreemptiveDrain via keeper-attested utilization rather
    /// than oracle status. Every downward move requires the oracle to be
    /// genuinely Healthy right now, verified live, not asserted.
    pub fn keeper_advance_state(
        e: Env,
        account: Address,
        keeper: Address,
        to: SystemState,
        utilization_bps: Option<u32>,
    ) {
        keeper.require_auth();
        let cfg = Self::config(e.clone(), account.clone());
        if keeper != cfg.keeper {
            panic_with_error!(e, RiskError::Unauthorized);
        }
        let current = Self::state(e.clone(), account.clone());

        if to < current {
            // Recovery must clear every real condition that could
            // independently justify the more-severe state being left, not
            // just the one the caller happens to mention. Emergency has
            // two independent triggers (oracle degraded, balance below
            // critical_floor) — recovering past it requires both cleared,
            // verified live, not asserted by the keeper.
            let oracle =
                OracleRouterClient::new(&e, &cfg.oracle_router).get_price(&cfg.oracle_asset);
            let paused = HealthMonitorClient::new(&e, &cfg.health_monitor).status();
            let tier0_balance = TokenClient::new(&e, &cfg.usdc_token).balance(&account);

            if paused {
                panic_with_error!(e, RiskError::InvalidTransition);
            }

            let ok = match to {
                SystemState::Normal => {
                    matches!(oracle.status, MirroredOracleStatus::Healthy)
                        && tier0_balance >= cfg.critical_floor
                }
                SystemState::PreemptiveDrain => {
                    !matches!(
                        oracle.status,
                        MirroredOracleStatus::Degraded | MirroredOracleStatus::HardStop
                    ) && tier0_balance >= cfg.critical_floor
                }
                _ => false,
            };
            if !ok {
                panic_with_error!(e, RiskError::InvalidTransition);
            }

            e.storage()
                .persistent()
                .set(&DataKey::State(account.clone()), &to);
            StateChanged {
                account,
                from: current,
                to,
            }
            .publish(&e);
            return;
        }

        // Utilization-driven upward path: PreemptiveDrain at
        // preemptive_util_bps, a full drain (Emergency) at the higher
        // full_drain_util_bps, both keeper-attested since venue
        // utilization is genuinely off-chain data (adr/0006), neither
        // derivable from oracle status or the on-chain balance check
        // check_and_trip already covers.
        if matches!(to, SystemState::PreemptiveDrain | SystemState::Emergency) && to >= current {
            let util = utilization_bps
                .unwrap_or_else(|| panic_with_error!(e, RiskError::InvalidTransition));
            let required = if to == SystemState::Emergency {
                cfg.full_drain_util_bps
            } else {
                cfg.preemptive_util_bps
            };
            if util < required {
                panic_with_error!(e, RiskError::InvalidTransition);
            }
            e.storage()
                .persistent()
                .set(&DataKey::State(account.clone()), &to);
            StateChanged {
                account,
                from: current,
                to,
            }
            .publish(&e);
            return;
        }

        panic_with_error!(e, RiskError::InvalidTransition);
    }

    /// One-time bootstrap for the global fee admin. In production this is
    /// the deployed `timelock` contract's own address: `timelock`'s
    /// `execute()` self-authorizes by passing its own address as the
    /// `admin` argument, so raising a fee genuinely requires a proposal
    /// that survived the 24h delay, per adr/0002 and adr/0007. Callable
    /// once; re-running it after an admin is already set is rejected so a
    /// later caller can't silently take over the fee-setting role.
    pub fn init_admin(e: Env, admin: Address) -> Result<(), RiskError> {
        admin.require_auth();
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(RiskError::InvalidConfig);
        }
        e.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Hands off fee governance to a new address, `timelock`'s own
    /// contract address in production. Only the current admin signs;
    /// `new_admin` does not, deliberately: a contract address can never
    /// sign a transaction the way an account key can, `require_auth()` for
    /// one only ever succeeds when that contract is the actual caller in
    /// the frame, so requiring its consent here is impossible, not just
    /// inconvenient. The current admin choosing the successor is the whole
    /// trust boundary, matching the standard ownership-transfer pattern
    /// used across the ecosystem.
    pub fn transfer_admin(
        e: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), RiskError> {
        current_admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RiskError::NotInitialized)?;
        if current_admin != stored_admin {
            return Err(RiskError::Unauthorized);
        }
        e.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Ships initialized to 0. Gated behind the stored admin (see
    /// `init_admin`), not just any address that signs for itself, per
    /// adr/0002 and adr/0007.
    pub fn set_fee_bps(e: Env, admin: Address, new_fee_bps: u32) -> Result<(), RiskError> {
        admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RiskError::NotInitialized)?;
        if admin != stored_admin {
            return Err(RiskError::Unauthorized);
        }
        if new_fee_bps > MAX_FEE_BPS {
            return Err(RiskError::CapExceeded);
        }
        e.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        Ok(())
    }

    pub fn fee_bps(e: Env) -> u32 {
        e.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Symbol,
    };

    // ################## MOCK ORACLE ROUTER ##################

    #[contracttype]
    enum MockOracleKey {
        Status,
    }

    #[contract]
    struct MockOracleRouter;

    #[contractimpl]
    impl MockOracleRouter {
        pub fn set_status(e: Env, status: MirroredOracleStatus) {
            e.storage().instance().set(&MockOracleKey::Status, &status);
        }
    }

    #[contractimpl]
    impl OracleRouterInterface for MockOracleRouter {
        fn get_price(e: Env, _asset: Asset) -> MirroredPriceQuote {
            let status = e
                .storage()
                .instance()
                .get(&MockOracleKey::Status)
                .unwrap_or(MirroredOracleStatus::Healthy);
            MirroredPriceQuote {
                price: 1_00000000,
                timestamp: e.ledger().timestamp(),
                status,
                conservative_low: 1_00000000,
                conservative_high: 1_00000000,
            }
        }
    }

    // ################## MOCK HEALTH MONITOR ##################

    #[contracttype]
    enum MockHealthKey {
        Paused,
    }

    #[contract]
    struct MockHealthMonitor;

    #[contractimpl]
    impl MockHealthMonitor {
        pub fn set_paused(e: Env, paused: bool) {
            e.storage().instance().set(&MockHealthKey::Paused, &paused);
        }
    }

    #[contractimpl]
    impl HealthMonitorInterface for MockHealthMonitor {
        fn status(e: Env) -> bool {
            e.storage()
                .instance()
                .get(&MockHealthKey::Paused)
                .unwrap_or(false)
        }
    }

    // ################## SETUP ##################

    struct Fixture<'a> {
        risk: RiskEngineClient<'a>,
        oracle: MockOracleRouterClient<'a>,
        health: MockHealthMonitorClient<'a>,
        usdc: Address,
        usdc_admin: StellarAssetClient<'a>,
        account: Address,
        keeper: Address,
    }

    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

    fn setup(e: &Env) -> Fixture<'_> {
        advance_to_realistic_ledger(e);
        e.mock_all_auths();

        let risk_id = e.register(RiskEngine, ());
        let risk = RiskEngineClient::new(e, &risk_id);

        let oracle_id = e.register(MockOracleRouter, ());
        let oracle = MockOracleRouterClient::new(e, &oracle_id);

        let health_id = e.register(MockHealthMonitor, ());
        let health = MockHealthMonitorClient::new(e, &health_id);

        let usdc_issuer = Address::generate(e);
        let sac = e.register_stellar_asset_contract_v2(usdc_issuer);
        let usdc = sac.address();
        let usdc_admin = StellarAssetClient::new(e, &usdc);

        let account = Address::generate(e);
        let keeper = Address::generate(e);

        let cfg = TierConfig {
            oracle_router: oracle_id,
            oracle_asset: Asset::Other(Symbol::new(e, "USDC")),
            health_monitor: health_id,
            usdc_token: usdc.clone(),
            keeper: keeper.clone(),
            tier0_bounds_min: 50_000_000_000,
            tier0_bounds_max: 200_000_000_000,
            critical_floor: 10_000_000_000,
            tvl_cap: 1_000_000_000_000,
            preemptive_util_bps: 8500,
            full_drain_util_bps: 9200,
        };
        risk.init(&account, &cfg, &100_000_000_000);

        Fixture {
            risk,
            oracle,
            health,
            usdc,
            usdc_admin,
            account,
            keeper,
        }
    }

    // ################## INIT / CONFIG ##################

    #[test]
    fn init_defaults_to_normal_state() {
        let e = Env::default();
        let f = setup(&e);
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);
        assert_eq!(f.risk.tier_state(&f.account).tier0_target, 100_000_000_000);
    }

    #[test]
    fn init_rejects_target_outside_bounds() {
        let e = Env::default();
        advance_to_realistic_ledger(&e);
        e.mock_all_auths();
        let risk_id = e.register(RiskEngine, ());
        let risk = RiskEngineClient::new(&e, &risk_id);
        let account = Address::generate(&e);
        let cfg = TierConfig {
            oracle_router: Address::generate(&e),
            oracle_asset: Asset::Other(Symbol::new(&e, "USDC")),
            health_monitor: Address::generate(&e),
            usdc_token: Address::generate(&e),
            keeper: Address::generate(&e),
            tier0_bounds_min: 50_000_000_000,
            tier0_bounds_max: 200_000_000_000,
            critical_floor: 10_000_000_000,
            tvl_cap: 1_000_000_000_000,
            preemptive_util_bps: 8500,
            full_drain_util_bps: 9200,
        };
        let result = risk.try_init(&account, &cfg, &10_000_000_000);
        assert!(result.is_err());
    }

    // ################## FEE HOOK (preserved from adr/0002) ##################

    #[test]
    fn fee_bps_defaults_to_zero() {
        let e = Env::default();
        let f = setup(&e);
        assert_eq!(f.risk.fee_bps(), 0);
    }

    #[test]
    fn set_fee_bps_before_admin_bootstrapped_fails() {
        let e = Env::default();
        let f = setup(&e);
        let outsider = Address::generate(&e);
        let result = f.risk.try_set_fee_bps(&outsider, &1500);
        assert!(result.is_err());
    }

    #[test]
    fn init_admin_then_set_fee_bps_within_ceiling_succeeds() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        f.risk.init_admin(&admin);
        f.risk.set_fee_bps(&admin, &1500);
        assert_eq!(f.risk.fee_bps(), 1500);
    }

    #[test]
    fn set_fee_bps_above_ceiling_fails() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        f.risk.init_admin(&admin);
        let result = f.risk.try_set_fee_bps(&admin, &(MAX_FEE_BPS + 1));
        assert!(result.is_err());
        assert_eq!(f.risk.fee_bps(), 0);
    }

    #[test]
    fn set_fee_bps_from_non_admin_address_fails() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        let outsider = Address::generate(&e);
        f.risk.init_admin(&admin);
        let result = f.risk.try_set_fee_bps(&outsider, &1500);
        assert!(result.is_err());
        assert_eq!(f.risk.fee_bps(), 0);
    }

    #[test]
    fn init_admin_cannot_be_called_twice() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        let attacker = Address::generate(&e);
        f.risk.init_admin(&admin);
        let result = f.risk.try_init_admin(&attacker);
        assert!(result.is_err());

        // The original admin, not the attacker, still governs the fee.
        f.risk.set_fee_bps(&admin, &500);
        assert_eq!(f.risk.fee_bps(), 500);
        let result = f.risk.try_set_fee_bps(&attacker, &500);
        assert!(result.is_err());
    }

    #[test]
    fn transfer_admin_hands_off_fee_governance() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        // Standing in for a real timelock contract's own address here:
        // the point under test is that whoever holds the Admin key can
        // set the fee, and the old admin no longer can, not how that
        // address is used elsewhere.
        let new_admin = Address::generate(&e);
        f.risk.init_admin(&admin);

        f.risk.transfer_admin(&admin, &new_admin);

        let result = f.risk.try_set_fee_bps(&admin, &500);
        assert!(
            result.is_err(),
            "the old admin must lose fee authority immediately"
        );
        f.risk.set_fee_bps(&new_admin, &500);
        assert_eq!(f.risk.fee_bps(), 500);
    }

    #[test]
    fn transfer_admin_from_non_admin_rejected() {
        let e = Env::default();
        let f = setup(&e);
        let admin = Address::generate(&e);
        let outsider = Address::generate(&e);
        let new_admin = Address::generate(&e);
        f.risk.init_admin(&admin);

        let result = f.risk.try_transfer_admin(&outsider, &new_admin);
        assert!(result.is_err());
        // Governance must still belong to the original admin.
        f.risk.set_fee_bps(&admin, &200);
        assert_eq!(f.risk.fee_bps(), 200);
    }

    // ################## TIER BOOKKEEPING ##################

    #[test]
    fn set_tier0_target_clamps_to_bounds() {
        let e = Env::default();
        let f = setup(&e);
        f.risk
            .set_tier0_target(&f.account, &f.keeper, &9_990_000_000_000);
        assert_eq!(f.risk.tier_state(&f.account).tier0_target, 200_000_000_000);

        f.risk.set_tier0_target(&f.account, &f.keeper, &1);
        assert_eq!(f.risk.tier_state(&f.account).tier0_target, 50_000_000_000);
    }

    #[test]
    fn non_keeper_cannot_set_tier0_target() {
        let e = Env::default();
        let f = setup(&e);
        let outsider = Address::generate(&e);
        let result = f
            .risk
            .try_set_tier0_target(&f.account, &outsider, &100_000_000_000);
        assert!(result.is_err());
    }

    #[test]
    fn deploy_allowed_respects_tvl_cap() {
        let e = Env::default();
        let f = setup(&e);
        let venue = Address::generate(&e);
        f.risk
            .record_tier1_position(&f.account, &f.keeper, &venue, &990_000_000_000);

        assert!(f.risk.deploy_allowed(&f.account, &500_0000000));
        assert!(!f.risk.deploy_allowed(&f.account, &20_000_000_000));
    }

    #[test]
    fn deploy_allowed_false_when_not_normal() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.risk.check_and_trip(&f.account);
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);
        assert!(!f.risk.deploy_allowed(&f.account, &1));
    }

    // ################## check_and_trip: REAL cross-contract checks ##################

    #[test]
    fn check_and_trip_stays_normal_when_everything_healthy() {
        let e = Env::default();
        let f = setup(&e);
        f.usdc_admin.mint(&f.account, &500_000_000_000);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Normal);
    }

    #[test]
    fn check_and_trip_moves_to_preemptive_drain_on_one_feed() {
        let e = Env::default();
        let f = setup(&e);
        // Fund above critical_floor so the real balance check doesn't
        // independently trigger Emergency and mask what this test targets.
        f.usdc_admin.mint(&f.account, &500_000_000_000);
        f.oracle.set_status(&MirroredOracleStatus::OneFeed);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::PreemptiveDrain);
    }

    #[test]
    fn check_and_trip_moves_to_emergency_on_degraded_oracle() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Emergency);
    }

    #[test]
    fn check_and_trip_moves_to_emergency_on_real_low_balance() {
        let e = Env::default();
        let f = setup(&e);
        // Real on-chain balance check: mint less than critical_floor
        // (10_000_000_000) into the real SAC token, not a claimed number.
        f.usdc_admin.mint(&f.account, &500_0000000);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Emergency);
    }

    #[test]
    fn check_and_trip_moves_to_paused_when_health_monitor_paused() {
        let e = Env::default();
        let f = setup(&e);
        f.health.set_paused(&true);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Paused);
    }

    #[test]
    fn check_and_trip_paused_takes_priority_over_oracle_degraded() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.health.set_paused(&true);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Paused);
    }

    #[test]
    fn check_and_trip_never_moves_state_downward() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.risk.check_and_trip(&f.account);
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);

        // Oracle recovers, but check_and_trip must never self-downgrade —
        // only keeper_advance_state can move state to a less severe level.
        f.oracle.set_status(&MirroredOracleStatus::Healthy);
        let result = f.risk.check_and_trip(&f.account);
        assert_eq!(result, SystemState::Emergency);
    }

    // ################## keeper_advance_state: real recovery gating ##################

    #[test]
    fn keeper_can_recover_to_normal_when_oracle_genuinely_healthy() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.risk.check_and_trip(&f.account);
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);

        // Recovery requires both Emergency triggers cleared, not just the
        // one that originally tripped it — fund above critical_floor too.
        f.usdc_admin.mint(&f.account, &500_000_000_000);
        f.oracle.set_status(&MirroredOracleStatus::Healthy);
        f.risk
            .keeper_advance_state(&f.account, &f.keeper, &SystemState::Normal, &None);
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);
    }

    #[test]
    fn keeper_recovery_rejected_when_oracle_still_unhealthy() {
        let e = Env::default();
        let f = setup(&e);
        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.risk.check_and_trip(&f.account);
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);

        // Oracle never recovered — a keeper claiming Normal must be
        // rejected against the real, currently-Degraded oracle status.
        let result =
            f.risk
                .try_keeper_advance_state(&f.account, &f.keeper, &SystemState::Normal, &None);
        assert!(result.is_err());
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);
    }

    #[test]
    fn keeper_recovery_rejected_when_balance_still_below_critical_floor() {
        // The exact gap a first draft of this check missed: Emergency has
        // two independent triggers (oracle degraded, balance too low).
        // Clearing only the oracle side must not be enough to recover.
        let e = Env::default();
        let f = setup(&e);
        assert_eq!(f.risk.config(&f.account).usdc_token, f.usdc);

        f.oracle.set_status(&MirroredOracleStatus::Degraded);
        f.risk.check_and_trip(&f.account);
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);

        // Oracle recovers, but the vault is still under-funded (0 balance,
        // never minted) — recovery must still be rejected.
        f.oracle.set_status(&MirroredOracleStatus::Healthy);
        let result =
            f.risk
                .try_keeper_advance_state(&f.account, &f.keeper, &SystemState::Normal, &None);
        assert!(result.is_err());
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);
    }

    #[test]
    fn non_keeper_cannot_advance_state() {
        let e = Env::default();
        let f = setup(&e);
        let outsider = Address::generate(&e);
        let result = f.risk.try_keeper_advance_state(
            &f.account,
            &outsider,
            &SystemState::PreemptiveDrain,
            &Some(9000),
        );
        assert!(result.is_err());
    }

    #[test]
    fn keeper_can_trigger_preemptive_drain_via_utilization_attestation() {
        let e = Env::default();
        let f = setup(&e);
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);

        f.risk.keeper_advance_state(
            &f.account,
            &f.keeper,
            &SystemState::PreemptiveDrain,
            &Some(9000),
        );
        assert_eq!(f.risk.state(&f.account), SystemState::PreemptiveDrain);
    }

    #[test]
    fn keeper_utilization_attestation_below_threshold_rejected() {
        let e = Env::default();
        let f = setup(&e);
        let result = f.risk.try_keeper_advance_state(
            &f.account,
            &f.keeper,
            &SystemState::PreemptiveDrain,
            &Some(1000), // below preemptive_util_bps (8500)
        );
        assert!(result.is_err());
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);
    }

    #[test]
    fn keeper_can_trigger_full_drain_via_utilization_attestation() {
        let e = Env::default();
        let f = setup(&e);
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);

        // 92%+, full_drain_util_bps, must reach Emergency directly from
        // Normal, not stop at PreemptiveDrain: a fast utilization spike
        // shouldn't need two separate keeper calls to escalate correctly.
        f.risk
            .keeper_advance_state(&f.account, &f.keeper, &SystemState::Emergency, &Some(9500));
        assert_eq!(f.risk.state(&f.account), SystemState::Emergency);
    }

    #[test]
    fn utilization_between_preemptive_and_full_drain_reaches_only_preemptive_drain() {
        let e = Env::default();
        let f = setup(&e);

        // 90% clears preemptive_util_bps (8500) but not full_drain_util_bps
        // (9200): claiming Emergency at this utilization must be rejected,
        // the tier between the two thresholds only justifies PreemptiveDrain.
        let result = f.risk.try_keeper_advance_state(
            &f.account,
            &f.keeper,
            &SystemState::Emergency,
            &Some(9000),
        );
        assert!(result.is_err());
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);

        f.risk.keeper_advance_state(
            &f.account,
            &f.keeper,
            &SystemState::PreemptiveDrain,
            &Some(9000),
        );
        assert_eq!(f.risk.state(&f.account), SystemState::PreemptiveDrain);
    }

    #[test]
    fn keeper_utilization_full_drain_attestation_below_threshold_rejected() {
        let e = Env::default();
        let f = setup(&e);
        let result = f.risk.try_keeper_advance_state(
            &f.account,
            &f.keeper,
            &SystemState::Emergency,
            &Some(9100), // below full_drain_util_bps (9200)
        );
        assert!(result.is_err());
        assert_eq!(f.risk.state(&f.account), SystemState::Normal);
    }

    #[test]
    fn init_rejects_full_drain_threshold_not_above_preemptive() {
        let e = Env::default();
        let risk = RiskEngineClient::new(&e, &e.register(RiskEngine, ()));
        let account = Address::generate(&e);
        e.mock_all_auths();
        let mut cfg = TierConfig {
            oracle_router: Address::generate(&e),
            oracle_asset: Asset::Other(Symbol::new(&e, "USDC")),
            health_monitor: Address::generate(&e),
            usdc_token: Address::generate(&e),
            keeper: Address::generate(&e),
            tier0_bounds_min: 50_000_000_000,
            tier0_bounds_max: 200_000_000_000,
            critical_floor: 10_000_000_000,
            tvl_cap: 1_000_000_000_000,
            preemptive_util_bps: 8500,
            full_drain_util_bps: 8500, // equal, not strictly greater: invalid
        };
        let result = risk.try_init(&account, &cfg, &100_000_000_000);
        assert!(result.is_err());

        cfg.full_drain_util_bps = 8000; // below preemptive: also invalid
        let result = risk.try_init(&account, &cfg, &100_000_000_000);
        assert!(result.is_err());
    }
}
