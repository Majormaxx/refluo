#![no_std]

//! YieldVenueAllowlist decodes untrusted calldata into a spend decision,
//! which makes its request-vector parsing the single highest-value target
//! for fuzzing anywhere in this workspace. Full design rationale tracked
//! internally, not in this repo.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

use refluo_common::{
    BlendRequest, BLEND_SUPPLY as SUPPLY, BLEND_SUPPLY_COLLATERAL as SUPPLY_COLLATERAL,
    BLEND_WITHDRAW as WITHDRAW, BLEND_WITHDRAW_COLLATERAL as WITHDRAW_COLLATERAL,
};
// 4 Borrow, 5 Repay, 6-9 auction/administrative request types: never
// permitted, no match arm handles them, they fall through to Unauthorized.
// Refluo is a pure yield-supply strategy; an agent treasury that can borrow
// is a liquidation risk it never needs to take.

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VenueConfig {
    pub venues: soroban_sdk::Vec<Address>,
    pub per_call_cap: i128,
    pub epoch_cap: i128,
    pub epoch_length: u64,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EpochSpend {
    pub spent: i128,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
    EpochSpend(Address, u32, u64),
    LastWriteEpoch(Address, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum VenueError {
    NotInitialized = 1,
    Unauthorized = 2,
    CapExceeded = 3,
    BadState = 4,
    AlreadyInstalled = 5,
    InvalidConfig = 6,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct VenueDeploy {
    #[topic]
    pub smart_account: Address,
    pub venue: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct VenueCapHit {
    #[topic]
    pub smart_account: Address,
    pub attempted: i128,
}

// Approximate Stellar ledger close time. VERIFY against observed mainnet
// cadence at deploy time — this only controls TTL sizing headroom, never a
// cap or safety invariant, so an approximation that errs generous is safe.
const SECONDS_PER_LEDGER: u64 = 5;

#[contract]
pub struct PolicyVenue;

#[contractimpl]
impl Policy for PolicyVenue {
    type AccountParams = VenueConfig;

    fn install(
        e: &Env,
        install_params: VenueConfig,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if install_params.venues.is_empty()
            || install_params.per_call_cap <= 0
            || install_params.epoch_cap < install_params.per_call_cap
            || install_params.epoch_length == 0
        {
            panic_with_error!(e, VenueError::InvalidConfig);
        }

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, VenueError::AlreadyInstalled);
        }
        e.storage().persistent().set(&key, &install_params);
    }

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if authenticated_signers.is_empty() {
            panic_with_error!(e, VenueError::Unauthorized);
        }

        let cfg: VenueConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| panic_with_error!(e, VenueError::NotInitialized));

        match context {
            Context::Contract(ContractContext {
                contract,
                fn_name,
                args,
            }) => {
                if !cfg.venues.contains(&contract) {
                    panic_with_error!(e, VenueError::Unauthorized);
                }
                if fn_name == symbol_short!("submit") {
                    enforce_blend_submit(e, &cfg, &args, &smart_account, context_rule.id);
                } else {
                    panic_with_error!(e, VenueError::Unauthorized);
                }
            }
            _ => panic_with_error!(e, VenueError::Unauthorized),
        }
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, VenueError::NotInitialized);
        }
        e.storage().persistent().remove(&key);
        e.storage()
            .persistent()
            .remove(&DataKey::LastWriteEpoch(smart_account, context_rule.id));
    }
}

#[contractimpl]
impl PolicyVenue {
    /// Read-only status query, not part of the Policy trait. Used by the
    /// planned dashboard/SDK and by tests to confirm install/uninstall
    /// actually touched storage, not just the smart account's own policy
    /// registry.
    pub fn config(e: Env, smart_account: Address, context_rule_id: u32) -> VenueConfig {
        e.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| panic_with_error!(e, VenueError::NotInitialized))
    }
}

/// Blend V2 `submit(from, spender, to, requests)`. Args order per the
/// verified pool interface. Defense in depth: from/spender/to must all
/// equal the vault address, independent of the request-type checks below.
fn enforce_blend_submit(
    e: &Env,
    cfg: &VenueConfig,
    args: &Vec<Val>,
    smart_account: &Address,
    rule_id: u32,
) {
    let from = args
        .get(0)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, VenueError::Unauthorized));
    let spender = args
        .get(1)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, VenueError::Unauthorized));
    let to = args
        .get(2)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, VenueError::Unauthorized));

    if &from != smart_account || &spender != smart_account || &to != smart_account {
        panic_with_error!(e, VenueError::Unauthorized);
    }

    let requests: Vec<BlendRequest> = args
        .get(3)
        .and_then(|v| Vec::<BlendRequest>::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, VenueError::Unauthorized));

    let mut deploy_total: i128 = 0;
    for r in requests.iter() {
        match r.request_type {
            SUPPLY | SUPPLY_COLLATERAL => {
                deploy_total = deploy_total
                    .checked_add(r.amount)
                    .unwrap_or_else(|| panic_with_error!(e, VenueError::BadState));
            }
            WITHDRAW | WITHDRAW_COLLATERAL => {
                // Always allowed: risk-reducing, never capped.
            }
            _ => panic_with_error!(e, VenueError::Unauthorized),
        }
    }

    if deploy_total > cfg.per_call_cap {
        panic_with_error!(e, VenueError::CapExceeded);
    }

    if deploy_total > 0 {
        bump_epoch_spend(e, smart_account, rule_id, deploy_total, cfg);
        VenueDeploy {
            smart_account: smart_account.clone(),
            venue: from,
            amount: deploy_total,
        }
        .publish(e);
    }
}

/// Fail-closed epoch counter. `last_write_epoch` is persistent so a missing
/// current-epoch temporary counter after a prior write reverts as BadState
/// instead of silently reading as zero spend mid-epoch. See adr/0003.
fn bump_epoch_spend(
    e: &Env,
    smart_account: &Address,
    rule_id: u32,
    amount: i128,
    cfg: &VenueConfig,
) {
    let now = e.ledger().timestamp();
    let epoch_index = now / cfg.epoch_length;

    let epoch_key = DataKey::EpochSpend(smart_account.clone(), rule_id, epoch_index);
    let last_write_key = DataKey::LastWriteEpoch(smart_account.clone(), rule_id);

    let last_write_epoch: Option<u64> = e.storage().persistent().get(&last_write_key);
    let temp_spend: Option<EpochSpend> = e.storage().temporary().get(&epoch_key);

    let current_spent = match (&last_write_epoch, &temp_spend) {
        (Some(last), None) if *last == epoch_index => {
            panic_with_error!(e, VenueError::BadState)
        }
        (_, Some(es)) => es.spent,
        _ => 0,
    };

    let new_spent = current_spent
        .checked_add(amount)
        .unwrap_or_else(|| panic_with_error!(e, VenueError::BadState));

    if new_spent > cfg.epoch_cap {
        VenueCapHit {
            smart_account: smart_account.clone(),
            attempted: new_spent,
        }
        .publish(e);
        panic_with_error!(e, VenueError::CapExceeded);
    }

    e.storage()
        .temporary()
        .set(&epoch_key, &EpochSpend { spent: new_spent });
    let ttl_ledgers = ((cfg.epoch_length / SECONDS_PER_LEDGER) as u32).saturating_mul(4);
    e.storage()
        .temporary()
        .extend_ttl(&epoch_key, ttl_ledgers, ttl_ledgers);
    e.storage().persistent().set(&last_write_key, &epoch_index);
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        IntoVal, String as SdkString,
    };
    use stellar_accounts::smart_account::ContextRuleType;

    fn setup(e: &Env) -> (PolicyVenueClient<'_>, Address, Address) {
        let contract_id = e.register(PolicyVenue, ());
        let client = PolicyVenueClient::new(e, &contract_id);
        let smart_account = Address::generate(e);
        let venue = Address::generate(e);
        (client, smart_account, venue)
    }

    fn rule(e: &Env, id: u32) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: SdkString::from_str(e, "r_yield"),
            signers: Vec::new(e),
            signer_ids: Vec::new(e),
            policies: Vec::new(e),
            policy_ids: Vec::new(e),
            valid_until: None,
        }
    }

    fn cfg(
        e: &Env,
        venue: &Address,
        per_call_cap: i128,
        epoch_cap: i128,
        epoch_length: u64,
    ) -> VenueConfig {
        VenueConfig {
            venues: Vec::from_array(e, [venue.clone()]),
            per_call_cap,
            epoch_cap,
            epoch_length,
        }
    }

    fn signers(e: &Env) -> Vec<Signer> {
        Vec::from_array(e, [Signer::Delegated(Address::generate(e))])
    }

    fn submit_context(
        e: &Env,
        venue: &Address,
        vault: &Address,
        requests: Vec<BlendRequest>,
    ) -> Context {
        let mut args = Vec::new(e);
        args.push_back(vault.into_val(e));
        args.push_back(vault.into_val(e));
        args.push_back(vault.into_val(e));
        args.push_back(requests.into_val(e));
        Context::Contract(ContractContext {
            contract: venue.clone(),
            fn_name: symbol_short!("submit"),
            args,
        })
    }

    fn req(e: &Env, request_type: u32, amount: i128) -> BlendRequest {
        BlendRequest {
            request_type,
            address: Address::generate(e),
            amount,
        }
    }

    #[test]
    fn install_rejects_empty_venues() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let mut bad = cfg(&e, &venue, 100, 1000, 86400);
        bad.venues = Vec::new(&e);
        let result = client.try_install(&bad, &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn install_rejects_epoch_cap_below_per_call_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let bad = cfg(&e, &venue, 1000, 500, 86400);
        let result = client.try_install(&bad, &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn install_rejects_double_install() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);
        let result = client.try_install(&c, &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_venue_not_in_allowlist() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let other_venue = Address::generate(&e);
        let ctx = submit_context(&e, &other_venue, &smart_account, Vec::new(&e));
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_empty_authenticated_signers() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = submit_context(&e, &venue, &smart_account, Vec::new(&e));
        let result = client.try_enforce(&ctx, &Vec::new(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_allows_supply_within_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 50)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_rejects_supply_over_per_call_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 101)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_allows_withdraw_uncapped() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        // Withdraw of an amount far exceeding per_call_cap must still pass:
        // caps meter risk-increasing flow only.
        let requests = Vec::from_array(
            &e,
            [
                req(&e, WITHDRAW, 999_999),
                req(&e, WITHDRAW_COLLATERAL, 999_999),
            ],
        );
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_rejects_borrow() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, 4 /* Borrow */, 1)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_all_non_supply_withdraw_types() {
        // Exhaustive over the verified Blend enum: only 0-3 are ever
        // permitted. 4 (Borrow), 5 (Repay), 6-9 (auction/admin) must all
        // reject, individually and mixed into an otherwise-valid vector.
        for bad_type in [4u32, 5, 6, 7, 8, 9] {
            let e = Env::default();
            e.mock_all_auths();
            let (client, smart_account, venue) = setup(&e);
            let c = cfg(&e, &venue, 100, 1000, 86400);
            client.install(&c, &rule(&e, 1), &smart_account);

            let requests = Vec::from_array(
                &e,
                [
                    req(&e, SUPPLY, 10),
                    req(&e, bad_type, 1),
                    req(&e, WITHDRAW, 5),
                ],
            );
            let ctx = submit_context(&e, &venue, &smart_account, requests);
            let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
            assert!(
                result.is_err(),
                "request_type {bad_type} must be rejected even mixed with valid requests"
            );
        }
    }

    #[test]
    fn enforce_rejects_destination_mismatch() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let not_vault = Address::generate(&e);
        let mut args = Vec::new(&e);
        args.push_back(not_vault.into_val(&e));
        args.push_back(smart_account.into_val(&e));
        args.push_back(smart_account.into_val(&e));
        args.push_back(Vec::<BlendRequest>::from_array(&e, [req(&e, SUPPLY, 10)]).into_val(&e));
        let ctx = Context::Contract(ContractContext {
            contract: venue.clone(),
            fn_name: symbol_short!("submit"),
            args,
        });
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_epoch_cap_never_exceeded_across_multiple_calls() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 40, 100, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        // 40 + 40 = 80, within epoch_cap 100.
        for _ in 0..2 {
            let requests = Vec::from_array(&e, [req(&e, SUPPLY, 40)]);
            let ctx = submit_context(&e, &venue, &smart_account, requests);
            client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        }

        // A third 40 would bring cumulative to 120 > epoch_cap 100: reject.
        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 40)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_epoch_counter_resets_on_new_epoch() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 40, 40, 100); // epoch_length = 100 seconds

        client.install(&c, &rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 40)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests.clone());
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);

        // Same epoch: a further spend must reject (cap already hit).
        let ctx2 = submit_context(&e, &venue, &smart_account, requests.clone());
        assert!(client
            .try_enforce(&ctx2, &signers(&e), &rule(&e, 1), &smart_account)
            .is_err());

        // Advance into a fresh epoch: the same spend must succeed again.
        e.ledger().with_mut(|l| l.timestamp += 200);
        let ctx3 = submit_context(&e, &venue, &smart_account, requests);
        client.enforce(&ctx3, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_fails_closed_on_mid_epoch_counter_eviction() {
        // A temporary counter evicted mid-epoch (TTL expiry or archival)
        // must revert as BadState, never silently read as zero spend. We
        // force this by writing last_write_epoch directly without a
        // matching temp counter, the exact state an eviction would leave
        // behind.
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 40, 100, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 10)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests.clone());
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);

        // Directly evict the temporary counter for the current epoch,
        // leaving last_write_epoch (persistent) pointing at it.
        let contract_id = client.address.clone();
        e.as_contract(&contract_id, || {
            let epoch_index = e.ledger().timestamp() / c.epoch_length;
            let epoch_key = DataKey::EpochSpend(smart_account.clone(), 1u32, epoch_index);
            e.storage().temporary().remove(&epoch_key);
        });

        let ctx2 = submit_context(&e, &venue, &smart_account, requests);
        let result = client.try_enforce(&ctx2, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(
            result.is_err(),
            "evicted mid-epoch counter must fail closed, not reset to zero"
        );
    }

    #[test]
    fn uninstall_removes_config_and_enforce_then_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 1000, 86400);
        client.install(&c, &rule(&e, 1), &smart_account);
        client.uninstall(&rule(&e, 1), &smart_account);

        let requests = Vec::from_array(&e, [req(&e, SUPPLY, 10)]);
        let ctx = submit_context(&e, &venue, &smart_account, requests);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    // ################## PROPERTY TESTS ##################

    use proptest::prelude::*;

    proptest! {
        #[test]
        fn prop_epoch_cap_never_exceeded(amounts in proptest::collection::vec(1i128..=30, 1..12)) {
            let e = Env::default();
            e.mock_all_auths();
            let contract_id = e.register(PolicyVenue, ());
            let client = PolicyVenueClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let venue = Address::generate(&e);
            let epoch_cap = 100i128;
            let c = VenueConfig {
                venues: Vec::from_array(&e, [venue.clone()]),
                per_call_cap: 30,
                epoch_cap,
                epoch_length: 86400,
            };
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let mut accepted_total: i128 = 0;
            for amount in amounts {
                let requests = Vec::from_array(&e, [BlendRequest {
                    request_type: SUPPLY,
                    address: Address::generate(&e),
                    amount,
                }]);
                let ctx = submit_context(&e, &venue, &smart_account, requests);
                let result = client.try_enforce(&ctx, &signers(&e), &r, &smart_account);
                if result.is_ok() {
                    accepted_total += amount;
                }
                // The invariant: whatever the interleaving of accept/reject,
                // accepted cumulative spend this epoch never exceeds the cap.
                prop_assert!(accepted_total <= epoch_cap);
            }
        }

        #[test]
        fn prop_borrow_and_auction_types_always_unreachable(
            request_type in proptest::sample::select(&[4u32, 5, 6, 7, 8, 9][..]),
            amount in 1i128..=10_000,
            wrap_with_valid in proptest::bool::ANY,
        ) {
            let e = Env::default();
            e.mock_all_auths();
            let contract_id = e.register(PolicyVenue, ());
            let client = PolicyVenueClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let venue = Address::generate(&e);
            let c = VenueConfig {
                venues: Vec::from_array(&e, [venue.clone()]),
                per_call_cap: 1_000_000,
                epoch_cap: 1_000_000,
                epoch_length: 86400,
            };
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let mut requests = Vec::new(&e);
            if wrap_with_valid {
                requests.push_back(BlendRequest { request_type: SUPPLY, address: Address::generate(&e), amount: 1 });
            }
            requests.push_back(BlendRequest { request_type, address: Address::generate(&e), amount });
            if wrap_with_valid {
                requests.push_back(BlendRequest { request_type: WITHDRAW, address: Address::generate(&e), amount: 1 });
            }

            let ctx = submit_context(&e, &venue, &smart_account, requests);
            let result = client.try_enforce(&ctx, &signers(&e), &r, &smart_account);
            prop_assert!(result.is_err(), "request_type {} must never be reachable", request_type);
        }
    }
}
