#![no_std]

//! RecallExecutor does one thing: move funds from an allowlisted venue
//! back to the vault. That narrowness is the security property, not
//! incidental — a compromised keeper key routed through this contract can
//! only de-yield the vault (rate-limited griefing), never move a single
//! stroop anywhere but home. Property-tested for exactly that: for all
//! inputs, funds move only venue -> vault. Full spec tracked internally,
//! not in this repo.

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
    BlendRequest, BLEND_WITHDRAW as WITHDRAW, BLEND_WITHDRAW_COLLATERAL as WITHDRAW_COLLATERAL,
};
// Every other Blend request type is risk-increasing or administrative:
// RecallExecutor never permits them, by construction (no match arm).

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecallConfig {
    pub venues: Vec<Address>,
    pub max_recalls_per_window: u32,
    pub window: u64,
    pub min_interval_ledgers: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RecallState {
    /// Ledger timestamps (seconds) of recent recalls, oldest first.
    pub recent: Vec<u64>,
    pub last_recall_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Config(Address, u32),
    State(Address, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RecallError {
    NotInitialized = 1,
    Unauthorized = 2,
    RateLimited = 3,
    InvalidConfig = 4,
    AlreadyInstalled = 5,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct RecallExecuted {
    #[topic]
    pub smart_account: Address,
    pub venue: Address,
}

#[contract]
pub struct PolicyRecall;

#[contractimpl]
impl Policy for PolicyRecall {
    type AccountParams = RecallConfig;

    fn install(
        e: &Env,
        install_params: RecallConfig,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if install_params.venues.is_empty()
            || install_params.max_recalls_per_window == 0
            || install_params.window == 0
        {
            panic_with_error!(e, RecallError::InvalidConfig);
        }

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, RecallError::AlreadyInstalled);
        }
        e.storage().persistent().set(&key, &install_params);
        e.storage().persistent().set(
            &DataKey::State(smart_account, context_rule.id),
            &RecallState {
                recent: Vec::new(e),
                last_recall_ledger: 0,
            },
        );
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
            panic_with_error!(e, RecallError::Unauthorized);
        }

        let cfg: RecallConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| panic_with_error!(e, RecallError::NotInitialized));

        let venue = match &context {
            Context::Contract(ContractContext {
                contract,
                fn_name,
                args,
            }) => {
                if !cfg.venues.contains(contract) {
                    panic_with_error!(e, RecallError::Unauthorized);
                }
                if *fn_name == symbol_short!("submit") {
                    enforce_blend_withdraw_only(e, args, &smart_account);
                } else {
                    panic_with_error!(e, RecallError::Unauthorized);
                }
                contract.clone()
            }
            _ => panic_with_error!(e, RecallError::Unauthorized),
        };

        check_and_bump_rate_limit(e, &smart_account, context_rule.id, &cfg);

        RecallExecuted {
            smart_account,
            venue,
        }
        .publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, RecallError::NotInitialized);
        }
        e.storage().persistent().remove(&key);
        e.storage()
            .persistent()
            .remove(&DataKey::State(smart_account, context_rule.id));
    }
}

/// Every request in the vector must be Withdraw/WithdrawCollateral, and
/// destination must decode to the vault's own address. Any other request
/// type present anywhere in the vector rejects the whole call: a keeper
/// cannot smuggle a Supply alongside a Withdraw to bypass venue caps.
fn enforce_blend_withdraw_only(e: &Env, args: &Vec<Val>, smart_account: &Address) {
    let from = args.get(0).and_then(|v| Address::try_from_val(e, &v).ok());
    let to = args.get(2).and_then(|v| Address::try_from_val(e, &v).ok());
    if from.as_ref() != Some(smart_account) || to.as_ref() != Some(smart_account) {
        panic_with_error!(e, RecallError::Unauthorized);
    }

    let requests: Vec<BlendRequest> = args
        .get(3)
        .and_then(|v| Vec::<BlendRequest>::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, RecallError::Unauthorized));

    if requests.is_empty() {
        panic_with_error!(e, RecallError::Unauthorized);
    }

    for r in requests.iter() {
        if r.request_type != WITHDRAW && r.request_type != WITHDRAW_COLLATERAL {
            panic_with_error!(e, RecallError::Unauthorized);
        }
    }
}

/// Rate limit: max N recalls per rolling window, plus a minimum ledger gap
/// between any two recalls. Fail-closed: reject rather than silently reset
/// on any inconsistency (mirrors the epoch-counter pattern in policy-venue,
/// adr/0003), even though this state is persistent (not temporary) so the
/// TTL-eviction failure mode doesn't apply here the same way.
fn check_and_bump_rate_limit(e: &Env, smart_account: &Address, rule_id: u32, cfg: &RecallConfig) {
    let key = DataKey::State(smart_account.clone(), rule_id);
    let mut state: RecallState = e
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, RecallError::NotInitialized));

    let now = e.ledger().timestamp();
    let current_ledger = e.ledger().sequence();

    if state.last_recall_ledger != 0 {
        let elapsed = current_ledger.saturating_sub(state.last_recall_ledger);
        if elapsed < cfg.min_interval_ledgers {
            panic_with_error!(e, RecallError::RateLimited);
        }
    }

    let cutoff = now.saturating_sub(cfg.window);
    let mut kept = Vec::new(e);
    for ts in state.recent.iter() {
        if ts > cutoff {
            kept.push_back(ts);
        }
    }

    if kept.len() >= cfg.max_recalls_per_window {
        panic_with_error!(e, RecallError::RateLimited);
    }

    kept.push_back(now);
    state.recent = kept;
    state.last_recall_ledger = current_ledger;
    e.storage().persistent().set(&key, &state);
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        IntoVal, String as SdkString,
    };
    use stellar_accounts::smart_account::ContextRuleType;

    // Real ledgers never start at timestamp/sequence 0; Env::default() does.
    // At exactly 0, `now.saturating_sub(window)` also lands on 0, so the
    // window filter's `ts > cutoff` boundary check silently evicts every
    // existing entry every call (0 is never > 0) — a test-harness artifact,
    // not a production bug, but one that hides the real rate-limit logic
    // unless every test starts from a realistic non-zero ledger state.
    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

    fn setup(e: &Env) -> (PolicyRecallClient<'_>, Address, Address) {
        advance_to_realistic_ledger(e);
        let contract_id = e.register(PolicyRecall, ());
        let client = PolicyRecallClient::new(e, &contract_id);
        let smart_account = Address::generate(e);
        let venue = Address::generate(e);
        (client, smart_account, venue)
    }

    fn rule(e: &Env, id: u32) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: SdkString::from_str(e, "r_recall"),
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
        max_per_window: u32,
        window: u64,
        min_interval: u32,
    ) -> RecallConfig {
        RecallConfig {
            venues: Vec::from_array(e, [venue.clone()]),
            max_recalls_per_window: max_per_window,
            window,
            min_interval_ledgers: min_interval,
        }
    }

    fn signers(e: &Env) -> Vec<Signer> {
        Vec::from_array(e, [Signer::Delegated(Address::generate(e))])
    }

    fn withdraw_context(
        e: &Env,
        venue: &Address,
        from: &Address,
        to: &Address,
        request_type: u32,
    ) -> Context {
        let mut args = Vec::new(e);
        args.push_back(from.into_val(e));
        args.push_back(from.into_val(e));
        args.push_back(to.into_val(e));
        let requests = Vec::from_array(
            e,
            [BlendRequest {
                request_type,
                address: Address::generate(e),
                amount: 10,
            }],
        );
        args.push_back(requests.into_val(e));
        Context::Contract(ContractContext {
            contract: venue.clone(),
            fn_name: symbol_short!("submit"),
            args,
        })
    }

    #[test]
    fn enforce_allows_withdraw_to_vault() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 6, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_rejects_destination_other_than_vault() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 6, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);

        let attacker = Address::generate(&e);
        let ctx = withdraw_context(&e, &venue, &smart_account, &attacker, WITHDRAW);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(
            result.is_err(),
            "recall to a non-vault destination must always be rejected"
        );
    }

    #[test]
    fn enforce_rejects_non_withdraw_request_type_smuggled_in() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 6, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);

        // request_type 0 = Supply: risk-increasing, must never be reachable
        // through RecallExecutor no matter how it's packaged.
        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, 0);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_venue_not_allowlisted() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 6, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);

        let other_venue = Address::generate(&e);
        let ctx = withdraw_context(&e, &other_venue, &smart_account, &smart_account, WITHDRAW);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rate_limits_max_recalls_per_window() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 3, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);

        for _ in 0..3 {
            let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
            client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        }
        // 4th recall within the same window must reject.
        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_window_slides_recalls_free_up_after_expiry() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 1, 100, 0); // 1 recall per 100s window

        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);

        // Immediately again: still inside the window, must reject.
        let ctx2 = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        assert!(client
            .try_enforce(&ctx2, &signers(&e), &rule(&e, 1), &smart_account)
            .is_err());

        // Advance past the window: must succeed again.
        e.ledger().with_mut(|l| l.timestamp += 200);
        let ctx3 = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        client.enforce(&ctx3, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_min_interval_ledgers_enforced() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 100, 3600, 60); // 60-ledger min gap

        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);

        // Next ledger: still within the 60-ledger gap, must reject.
        e.ledger().with_mut(|l| l.sequence_number += 1);
        let ctx2 = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        assert!(client
            .try_enforce(&ctx2, &signers(&e), &rule(&e, 1), &smart_account)
            .is_err());

        // 60 ledgers later: gap satisfied, must succeed.
        e.ledger().with_mut(|l| l.sequence_number += 60);
        let ctx3 = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        client.enforce(&ctx3, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn uninstall_removes_state_and_enforce_then_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, venue) = setup(&e);
        let c = cfg(&e, &venue, 6, 3600, 0);
        client.install(&c, &rule(&e, 1), &smart_account);
        client.uninstall(&rule(&e, 1), &smart_account);

        let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    // ################## PROPERTY TESTS ##################

    proptest! {
        #[test]
        fn prop_destination_always_equals_vault(
            request_type in proptest::sample::select(&[0u32, 1, 2, 3, 4, 5, 6, 7, 8, 9][..]),
        ) {
            // For all inputs (including invalid request types), a recall to
            // any address other than the vault must be rejected. This is
            // the property that bounds keeper-key-compromise damage to
            // griefing: funds move only venue -> vault, never elsewhere.
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let contract_id = e.register(PolicyRecall, ());
            let client = PolicyRecallClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let venue = Address::generate(&e);
            let attacker = Address::generate(&e);
            let c = cfg(&e, &venue, 100, 3600, 0);
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let ctx = withdraw_context(&e, &venue, &smart_account, &attacker, request_type);
            let result = client.try_enforce(&ctx, &signers(&e), &r, &smart_account);
            prop_assert!(result.is_err());
        }

        #[test]
        fn prop_rate_limit_monotone(
            max_per_window in 1u32..=10,
            attempts in 1u32..=20,
        ) {
            // Rate limit is monotone: across any number of same-ledger
            // attempts, the number of accepted recalls never exceeds
            // max_recalls_per_window.
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let contract_id = e.register(PolicyRecall, ());
            let client = PolicyRecallClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let venue = Address::generate(&e);
            let c = cfg(&e, &venue, max_per_window, 3600, 0);
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let mut accepted = 0u32;
            for _ in 0..attempts {
                let ctx = withdraw_context(&e, &venue, &smart_account, &smart_account, WITHDRAW);
                if client.try_enforce(&ctx, &signers(&e), &r, &smart_account).is_ok() {
                    accepted += 1;
                }
                prop_assert!(accepted <= max_per_window);
            }
        }
    }
}
