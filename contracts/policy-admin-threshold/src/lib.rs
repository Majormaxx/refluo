#![no_std]

//! PolicyAdminThreshold: the real 2-of-3 (or N-of-M) multisig gate for
//! `vault`'s `R_ADMIN` context rule. A thin wrapper around OZ
//! `stellar-accounts`' own `simple_threshold` module: every method below
//! delegates straight to the library's `install`/`enforce`/`uninstall`,
//! which already handle storage, event emission, and threshold validation.
//! No Refluo-specific logic, per adr/0001 doctrine (OZ over hand-rolled
//! auth). Without a policy attached, a `ContextRule` accepts any single
//! listed signer alone; attaching this is what actually turns a listed
//! signer set into an M-of-N requirement. See adr/0008.

use soroban_sdk::{auth::Context, contract, contractimpl, Address, Env, Vec};
use stellar_accounts::{
    policies::{simple_threshold, Policy},
    smart_account::{ContextRule, Signer},
};

pub use stellar_accounts::policies::simple_threshold::SimpleThresholdAccountParams;

#[contract]
pub struct PolicyAdminThreshold;

#[contractimpl]
impl Policy for PolicyAdminThreshold {
    type AccountParams = SimpleThresholdAccountParams;

    fn install(
        e: &Env,
        install_params: SimpleThresholdAccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        simple_threshold::install(e, &install_params, &context_rule, &smart_account);
    }

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        simple_threshold::enforce(
            e,
            &context,
            &authenticated_signers,
            &context_rule,
            &smart_account,
        );
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        simple_threshold::uninstall(e, &context_rule, &smart_account);
    }
}

#[contractimpl]
impl PolicyAdminThreshold {
    /// Read the currently configured threshold. Real operational need:
    /// an admin verifying the live requirement before proposing a signer
    /// change, not something worth guessing from off-chain records.
    pub fn get_threshold(e: Env, context_rule_id: u32, smart_account: Address) -> u32 {
        simple_threshold::get_threshold(&e, context_rule_id, &smart_account)
    }

    /// Raise or lower the threshold. Per the library's own documented
    /// security warning: call this BEFORE removing signers or AFTER
    /// adding them, in the same transaction where possible, or the
    /// threshold can silently become unreachable (DoS) or too weak.
    pub fn set_threshold(
        e: Env,
        threshold: u32,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        simple_threshold::set_threshold(&e, threshold, &context_rule, &smart_account);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use stellar_accounts::smart_account::ContextRuleType;

    fn rule(e: &Env, id: u32, signers: Vec<Signer>) -> ContextRule {
        // signer_ids/policy_ids are the global registry's own bookkeeping,
        // untouched by simple_threshold's install/enforce/uninstall; empty
        // placeholders are fine for exercising this policy in isolation.
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: soroban_sdk::String::from_str(e, "R_ADMIN"),
            signers,
            signer_ids: Vec::new(e),
            policies: Vec::new(e),
            policy_ids: Vec::new(e),
            valid_until: None,
        }
    }

    fn call_context(e: &Env, contract: &Address) -> Context {
        Context::Contract(soroban_sdk::auth::ContractContext {
            contract: contract.clone(),
            fn_name: soroban_sdk::symbol_short!("noop"),
            args: Vec::new(e),
        })
    }

    #[test]
    fn two_of_three_signers_pass() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let c = Signer::Delegated(Address::generate(&e));
        let all_signers = Vec::from_array(&e, [a.clone(), b.clone(), c.clone()]);
        let r = rule(&e, 1, all_signers);

        client.install(
            &SimpleThresholdAccountParams { threshold: 2 },
            &r,
            &smart_account,
        );
        assert_eq!(client.get_threshold(&1, &smart_account), 2);

        let ctx = call_context(&e, &smart_account);
        let two = Vec::from_array(&e, [a, b]);
        client.enforce(&ctx, &two, &r, &smart_account);
    }

    #[test]
    fn one_of_three_signers_rejected() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let c = Signer::Delegated(Address::generate(&e));
        let all_signers = Vec::from_array(&e, [a.clone(), b, c]);
        let r = rule(&e, 1, all_signers);

        client.install(
            &SimpleThresholdAccountParams { threshold: 2 },
            &r,
            &smart_account,
        );

        let ctx = call_context(&e, &smart_account);
        let one = Vec::from_array(&e, [a]);
        let result = client.try_enforce(&ctx, &one, &r, &smart_account);
        assert!(
            result.is_err(),
            "a single signer must not satisfy a 2-of-3 threshold"
        );
    }

    #[test]
    fn three_of_three_signers_pass() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let c = Signer::Delegated(Address::generate(&e));
        let all_signers = Vec::from_array(&e, [a.clone(), b.clone(), c.clone()]);
        let r = rule(&e, 1, all_signers);

        client.install(
            &SimpleThresholdAccountParams { threshold: 2 },
            &r,
            &smart_account,
        );

        let ctx = call_context(&e, &smart_account);
        let three = Vec::from_array(&e, [a, b, c]);
        client.enforce(&ctx, &three, &r, &smart_account);
    }

    #[test]
    fn install_with_threshold_above_signer_count_rejected() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let r = rule(&e, 1, Vec::from_array(&e, [a, b]));

        let result = client.try_install(
            &SimpleThresholdAccountParams { threshold: 3 },
            &r,
            &smart_account,
        );
        assert!(
            result.is_err(),
            "a 3-signer threshold over a 2-signer rule must be rejected"
        );
    }

    #[test]
    fn uninstall_then_enforce_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let r = rule(&e, 1, Vec::from_array(&e, [a.clone(), b.clone()]));

        client.install(
            &SimpleThresholdAccountParams { threshold: 2 },
            &r,
            &smart_account,
        );
        client.uninstall(&r, &smart_account);

        let ctx = call_context(&e, &smart_account);
        let two = Vec::from_array(&e, [a, b]);
        let result = client.try_enforce(&ctx, &two, &r, &smart_account);
        assert!(
            result.is_err(),
            "enforce after uninstall must fail, not silently pass"
        );
    }

    #[test]
    fn set_threshold_updates_requirement() {
        let e = Env::default();
        e.mock_all_auths();
        let contract_id = e.register(PolicyAdminThreshold, ());
        let client = PolicyAdminThresholdClient::new(&e, &contract_id);
        let smart_account = Address::generate(&e);

        let a = Signer::Delegated(Address::generate(&e));
        let b = Signer::Delegated(Address::generate(&e));
        let c = Signer::Delegated(Address::generate(&e));
        let r = rule(&e, 1, Vec::from_array(&e, [a.clone(), b.clone(), c]));

        client.install(
            &SimpleThresholdAccountParams { threshold: 2 },
            &r,
            &smart_account,
        );
        client.set_threshold(&3, &r, &smart_account);
        assert_eq!(client.get_threshold(&1, &smart_account), 3);

        let ctx = call_context(&e, &smart_account);
        let two = Vec::from_array(&e, [a, b]);
        let result = client.try_enforce(&ctx, &two, &r, &smart_account);
        assert!(
            result.is_err(),
            "raising the threshold to 3 must reject a 2-signer attempt"
        );
    }
}
