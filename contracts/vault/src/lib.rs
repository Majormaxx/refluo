#![no_std]

//! AgentVault — thin wrapper around OZ `stellar-accounts` (pinned =0.7.2).
//!
//! Every method below is a verbatim copy of `SmartAccount`'s own trait
//! default body (require_auth + delegate to `storage::*`) — not because the
//! logic differs, but because `#[contractimpl]` only exports methods that
//! are textually present in the impl block; a trait default that isn't
//! re-declared here compiles fine at the Rust level but is never exposed as
//! a callable contract function (confirmed empirically: an empty `impl
//! SmartAccount for Vault {}` built cleanly and then failed at runtime with
//! "calling unknown contract function"). OZ's own README shows the same
//! full re-declaration for exactly this reason.
//!
//! `__check_auth` is the one place Refluo write real logic: none. It
//! delegates entirely to `do_check_auth`. Hand-rolling `__check_auth` is
//! how solo devs die (adr/0001); this contract exists specifically to
//! avoid writing one.
//!
//! `ExecutionEntryPoint` (the `execute` trait) is not implemented yet —
//! deferred until a policy needs to call back into the vault, not needed
//! for what's built so far.

use soroban_sdk::{
    auth::Context, auth::CustomAccountInterface, contract, contractimpl, crypto::Hash, Address,
    Env, Map, String, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, do_check_auth, AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccount,
    SmartAccountError,
};

#[contract]
pub struct Vault;

#[contractimpl]
impl SmartAccount for Vault {
    fn get_context_rules_count(e: &Env) -> u32 {
        smart_account::get_context_rules_count(e)
    }

    fn get_context_rule(e: &Env, context_rule_id: u32) -> ContextRule {
        smart_account::get_context_rule(e, context_rule_id)
    }

    // get_signer_id / get_policy_id intentionally not re-declared: their
    // default bodies call storage::get_signer_id / storage::get_policy_id,
    // which are private to the stellar-accounts crate (not in the
    // `pub use storage::{...}` list, unlike every other method here). Rust
    // still accepts the trait as implemented via the default, but
    // #[contractimpl] only exports methods textually present in this impl
    // block, so these two are not callable as vault contract functions.
    // Neither is required for what's built so far (agent pays within
    // caps, keeper recalls, nobody borrows, admin self-rescues); revisit
    // if the SDK/dashboard ever needs registry-ID lookups directly.

    fn add_context_rule(
        e: &Env,
        context_type: ContextRuleType,
        name: String,
        valid_until: Option<u32>,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> ContextRule {
        e.current_contract_address().require_auth();
        smart_account::add_context_rule(e, &context_type, &name, valid_until, &signers, &policies)
    }

    fn update_context_rule_name(e: &Env, context_rule_id: u32, name: String) -> ContextRule {
        e.current_contract_address().require_auth();
        smart_account::update_context_rule_name(e, context_rule_id, &name)
    }

    fn update_context_rule_valid_until(
        e: &Env,
        context_rule_id: u32,
        valid_until: Option<u32>,
    ) -> ContextRule {
        e.current_contract_address().require_auth();
        smart_account::update_context_rule_valid_until(e, context_rule_id, valid_until)
    }

    fn remove_context_rule(e: &Env, context_rule_id: u32) {
        e.current_contract_address().require_auth();
        smart_account::remove_context_rule(e, context_rule_id);
    }

    fn add_signer(e: &Env, context_rule_id: u32, signer: Signer) -> u32 {
        e.current_contract_address().require_auth();
        smart_account::add_signer(e, context_rule_id, &signer)
    }

    fn remove_signer(e: &Env, context_rule_id: u32, signer_id: u32) {
        e.current_contract_address().require_auth();
        smart_account::remove_signer(e, context_rule_id, signer_id);
    }

    fn add_policy(e: &Env, context_rule_id: u32, policy: Address, install_param: Val) -> u32 {
        e.current_contract_address().require_auth();
        smart_account::add_policy(e, context_rule_id, &policy, install_param)
    }

    fn remove_policy(e: &Env, context_rule_id: u32, policy_id: u32) {
        e.current_contract_address().require_auth();
        smart_account::remove_policy(e, context_rule_id, policy_id);
    }
}

#[contractimpl]
impl CustomAccountInterface for Vault {
    type Signature = AuthPayload;
    type Error = SmartAccountError;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), SmartAccountError> {
        do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}
