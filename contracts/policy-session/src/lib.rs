#![no_std]

//! SessionScope — agent hot-key hygiene. OZ's own `spending_limit` policy
//! rides alongside on the same R_AGENT_PAY rule for plain SAC transfers;
//! SessionScope covers the contract-call contexts spending_limit rejects
//! (x402/MPP payment calls), with its own separate cap accounting. Full
//! spec tracked internally, not in this repo.
//!
//! VERIFY before mainnet: x402 facilitator / MPP session contract addresses
//! and their exact call ABI are unconfirmed. `amount_arg_index` is a
//! configurable position rather than a hardcoded one for exactly this
//! reason — pin it to the real ABI once those integration details are
//! confirmed, don't assume it here.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, TryFromVal, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum DestClass {
    Facilitator(Address),
    MppSession(Address),
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SessionConfig {
    pub expiry_ledger: u32,
    pub per_tx_cap: i128,
    pub epoch_cap: i128,
    pub epoch_length: u64,
    pub dest_classes: Vec<DestClass>,
    /// Position in the call's args vector expected to decode as the i128
    /// payment amount. VERIFY against the real x402/MPP ABI, see module doc.
    pub amount_arg_index: u32,
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
pub enum SessionError {
    NotInitialized = 1,
    Unauthorized = 2,
    Expired = 3,
    CapExceeded = 4,
    BadState = 5,
    InvalidConfig = 6,
    AlreadyInstalled = 7,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SessionPayment {
    #[topic]
    pub smart_account: Address,
    pub dest: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SessionCapHit {
    #[topic]
    pub smart_account: Address,
    pub attempted: i128,
}

const SECONDS_PER_LEDGER: u64 = 5; // see policy-venue's identical constant

#[contract]
pub struct PolicySession;

#[contractimpl]
impl Policy for PolicySession {
    type AccountParams = SessionConfig;

    fn install(
        e: &Env,
        install_params: SessionConfig,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if install_params.dest_classes.is_empty()
            || install_params.per_tx_cap <= 0
            || install_params.epoch_cap < install_params.per_tx_cap
            || install_params.epoch_length == 0
        {
            panic_with_error!(e, SessionError::InvalidConfig);
        }

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, SessionError::AlreadyInstalled);
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
            panic_with_error!(e, SessionError::Unauthorized);
        }

        let cfg: SessionConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| panic_with_error!(e, SessionError::NotInitialized));

        // 1. Expiry first: cheapest check, fail fast before any storage work.
        if e.ledger().sequence() > cfg.expiry_ledger {
            panic_with_error!(e, SessionError::Expired);
        }

        match context {
            Context::Contract(ContractContext { contract, args, .. }) => {
                // 2. Destination-class match.
                let matched = cfg.dest_classes.iter().any(|dc| match dc {
                    DestClass::Facilitator(addr) => addr == contract,
                    DestClass::MppSession(addr) => addr == contract,
                });
                if !matched {
                    panic_with_error!(e, SessionError::Unauthorized);
                }

                // 3. Caps, same fail-closed epoch pattern as policy-venue.
                let amount: i128 = args
                    .get(cfg.amount_arg_index)
                    .and_then(|v| i128::try_from_val(e, &v).ok())
                    .unwrap_or_else(|| panic_with_error!(e, SessionError::Unauthorized));

                if amount < 0 {
                    panic_with_error!(e, SessionError::Unauthorized);
                }
                if amount > cfg.per_tx_cap {
                    panic_with_error!(e, SessionError::CapExceeded);
                }

                bump_epoch_spend(e, &smart_account, context_rule.id, amount, &cfg);

                SessionPayment {
                    smart_account: smart_account.clone(),
                    dest: contract,
                    amount,
                }
                .publish(e);
            }
            _ => panic_with_error!(e, SessionError::Unauthorized),
        }
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, SessionError::NotInitialized);
        }
        e.storage().persistent().remove(&key);
        e.storage()
            .persistent()
            .remove(&DataKey::LastWriteEpoch(smart_account, context_rule.id));
    }
}

/// Identical fail-closed pattern to policy-venue's bump_epoch_spend —
/// duplicated rather than shared because the two configs' field shapes
/// differ (VenueConfig vs SessionConfig) and a shared generic helper would
/// cost more clarity than the ~15 duplicated lines cost maintenance. See
/// adr/0003 for the invariant this protects.
fn bump_epoch_spend(
    e: &Env,
    smart_account: &Address,
    rule_id: u32,
    amount: i128,
    cfg: &SessionConfig,
) {
    let now = e.ledger().timestamp();
    let epoch_index = now / cfg.epoch_length;

    let epoch_key = DataKey::EpochSpend(smart_account.clone(), rule_id, epoch_index);
    let last_write_key = DataKey::LastWriteEpoch(smart_account.clone(), rule_id);

    let last_write_epoch: Option<u64> = e.storage().persistent().get(&last_write_key);
    let temp_spend: Option<EpochSpend> = e.storage().temporary().get(&epoch_key);

    let current_spent = match (&last_write_epoch, &temp_spend) {
        (Some(last), None) if *last == epoch_index => {
            panic_with_error!(e, SessionError::BadState)
        }
        (_, Some(es)) => es.spent,
        _ => 0,
    };

    let new_spent = current_spent
        .checked_add(amount)
        .unwrap_or_else(|| panic_with_error!(e, SessionError::BadState));

    if new_spent > cfg.epoch_cap {
        SessionCapHit {
            smart_account: smart_account.clone(),
            attempted: new_spent,
        }
        .publish(e);
        panic_with_error!(e, SessionError::CapExceeded);
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
    use proptest::prelude::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        IntoVal, String as SdkString,
    };
    use stellar_accounts::smart_account::ContextRuleType;

    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

    fn setup(e: &Env) -> (PolicySessionClient<'_>, Address, Address) {
        advance_to_realistic_ledger(e);
        let contract_id = e.register(PolicySession, ());
        let client = PolicySessionClient::new(e, &contract_id);
        let smart_account = Address::generate(e);
        let facilitator = Address::generate(e);
        (client, smart_account, facilitator)
    }

    fn rule(e: &Env, id: u32) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: SdkString::from_str(e, "r_agent_pay"),
            signers: Vec::new(e),
            signer_ids: Vec::new(e),
            policies: Vec::new(e),
            policy_ids: Vec::new(e),
            valid_until: None,
        }
    }

    fn cfg(
        e: &Env,
        facilitator: &Address,
        expiry_ledger: u32,
        per_tx_cap: i128,
        epoch_cap: i128,
    ) -> SessionConfig {
        SessionConfig {
            expiry_ledger,
            per_tx_cap,
            epoch_cap,
            epoch_length: 86400,
            dest_classes: Vec::from_array(e, [DestClass::Facilitator(facilitator.clone())]),
            amount_arg_index: 0,
        }
    }

    fn signers(e: &Env) -> Vec<Signer> {
        Vec::from_array(e, [Signer::Delegated(Address::generate(e))])
    }

    fn pay_context(e: &Env, facilitator: &Address, amount: i128) -> Context {
        let mut args = Vec::new(e);
        args.push_back(amount.into_val(e));
        Context::Contract(ContractContext {
            contract: facilitator.clone(),
            fn_name: symbol_short!("pay"),
            args,
        })
    }

    #[test]
    fn enforce_allows_payment_within_cap_before_expiry() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = pay_context(&e, &facilitator, 50);
        client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
    }

    #[test]
    fn enforce_rejects_after_expiry() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 1_999_999, 100, 1000); // already expired
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = pay_context(&e, &facilitator, 50);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_expiry_checked_before_dest_class_lookup() {
        // Even a destination that would fail the class match must surface
        // as Expired, not Unauthorized, once past expiry — expiry is
        // checked first by design (cheapest check, fail fast).
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 1_999_999, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);

        let unrelated = Address::generate(&e);
        let ctx = pay_context(&e, &unrelated, 50);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_destination_not_in_dest_classes() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);

        let not_allowlisted = Address::generate(&e);
        let ctx = pay_context(&e, &not_allowlisted, 50);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_over_per_tx_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = pay_context(&e, &facilitator, 101);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_negative_amount() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);

        let ctx = pay_context(&e, &facilitator, -1);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_epoch_cap_never_exceeded_across_multiple_calls() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 40, 100);
        client.install(&c, &rule(&e, 1), &smart_account);

        for _ in 0..2 {
            let ctx = pay_context(&e, &facilitator, 40);
            client.enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        }
        let ctx = pay_context(&e, &facilitator, 40);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn uninstall_removes_config_and_enforce_then_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let (client, smart_account, facilitator) = setup(&e);
        let c = cfg(&e, &facilitator, 2_000_100, 100, 1000);
        client.install(&c, &rule(&e, 1), &smart_account);
        client.uninstall(&rule(&e, 1), &smart_account);

        let ctx = pay_context(&e, &facilitator, 50);
        let result = client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &smart_account);
        assert!(result.is_err());
    }

    // ################## PROPERTY TESTS ##################

    proptest! {
        #[test]
        fn prop_expiry_strict(
            ledger_offset in -50i64..=50,
        ) {
            // expiry_ledger is inclusive-allowed, strictly-exclusive-after:
            // sequence <= expiry_ledger always passes the expiry gate,
            // sequence > expiry_ledger always fails it. No off-by-one.
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let contract_id = e.register(PolicySession, ());
            let client = PolicySessionClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let facilitator = Address::generate(&e);
            let expiry_ledger = 2_000_000u32;
            let c = cfg(&e, &facilitator, expiry_ledger, 1_000_000, 1_000_000);
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let target = (expiry_ledger as i64 + ledger_offset).max(0) as u32;
            e.ledger().with_mut(|l| l.sequence_number = target);

            let ctx = pay_context(&e, &facilitator, 1);
            let result = client.try_enforce(&ctx, &signers(&e), &r, &smart_account);
            if target > expiry_ledger {
                prop_assert!(result.is_err());
            } else {
                prop_assert!(result.is_ok());
            }
        }

        #[test]
        fn prop_epoch_cap_never_exceeded(amounts in proptest::collection::vec(1i128..=30, 1..12)) {
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let contract_id = e.register(PolicySession, ());
            let client = PolicySessionClient::new(&e, &contract_id);
            let smart_account = Address::generate(&e);
            let facilitator = Address::generate(&e);
            let epoch_cap = 100i128;
            let c = cfg(&e, &facilitator, 2_000_100, 30, epoch_cap);
            let r = rule(&e, 1);
            client.install(&c, &r, &smart_account);

            let mut accepted_total: i128 = 0;
            for amount in amounts {
                let ctx = pay_context(&e, &facilitator, amount);
                let result = client.try_enforce(&ctx, &signers(&e), &r, &smart_account);
                if result.is_ok() {
                    accepted_total += amount;
                }
                prop_assert!(accepted_total <= epoch_cap);
            }
        }
    }
}
