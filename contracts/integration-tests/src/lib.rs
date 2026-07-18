//! Cross-contract integration tests: vault + policies wired together.
//! Not compiled to WASM, not a workspace dependency of any contract,
//! dev-only, proves the composition the individual unit test suites can't.

#![cfg(test)]

use refluo_policy_admin_threshold::{PolicyAdminThreshold, PolicyAdminThresholdClient};
use refluo_policy_recall::{PolicyRecall, RecallConfig};
use refluo_policy_session::{DestClass, PolicySession, SessionConfig};
use refluo_policy_venue::{PolicyVenue, VenueConfig};
use refluo_vault::Vault;
use soroban_sdk::{
    auth::{Context, ContractContext},
    map, symbol_short,
    testutils::{Address as _, Ledger},
    Address, Env, IntoVal, Map, String as SdkString, Val, Vec,
};
use stellar_accounts::smart_account::{ContextRuleType, Signer, SmartAccountClient};

fn advance_to_realistic_ledger(e: &Env) {
    e.ledger().with_mut(|l| {
        l.timestamp = 2_000_000_000;
        l.sequence_number = 2_000_000;
    });
}

/// The real R_ADMIN topology every deployed vault uses: 3 named signers, a
/// 2-of-3 `PolicyAdminThreshold` gate, bootstrapped at construction, the
/// only point in the vault's life a context rule can be created without
/// already having one to authorize against (see the vault's own
/// `__constructor` doc comment, adr/0008).
struct AdminTopology {
    admin_a: Signer,
    admin_b: Signer,
    admin_c: Signer,
    admin_policy_id: Address,
}

fn deploy_vault(e: &Env) -> (Address, SmartAccountClient<'_>, AdminTopology) {
    let admin_policy_id = e.register(PolicyAdminThreshold, ());
    let admin_a = Signer::Delegated(Address::generate(e));
    let admin_b = Signer::Delegated(Address::generate(e));
    let admin_c = Signer::Delegated(Address::generate(e));
    let admin_signers = Vec::from_array(e, [admin_a.clone(), admin_b.clone(), admin_c.clone()]);

    let vault_id = e.register(Vault, (admin_signers, 2u32, admin_policy_id.clone()));
    let client = SmartAccountClient::new(e, &vault_id);
    (
        vault_id,
        client,
        AdminTopology {
            admin_a,
            admin_b,
            admin_c,
            admin_policy_id,
        },
    )
}

#[test]
fn constructor_bootstraps_r_admin_with_real_two_of_three_threshold() {
    // The bootstrap this whole self-rescue guarantee depends on: R_ADMIN
    // has to exist with a real 2-of-3 gate before any other context rule
    // can, since every other admin-management call resolves auth against
    // an *existing* rule. Confirms the constructor created rule 0 with
    // all three signers and that PolicyAdminThreshold, not just the
    // vault's registry, actually stored threshold=2.
    let e = Env::default();
    advance_to_realistic_ledger(&e);
    e.mock_all_auths();

    let (vault_id, vault, admin) = deploy_vault(&e);

    assert_eq!(vault.get_context_rules_count(), 1);
    let r_admin = vault.get_context_rule(&0);
    assert_eq!(r_admin.signers.len(), 3);
    assert!(r_admin.signers.contains(&admin.admin_a));
    assert!(r_admin.signers.contains(&admin.admin_b));
    assert!(r_admin.signers.contains(&admin.admin_c));
    assert_eq!(r_admin.policies.len(), 1);
    assert_eq!(r_admin.policies.get_unchecked(0), admin.admin_policy_id);

    let policy_client = PolicyAdminThresholdClient::new(&e, &admin.admin_policy_id);
    assert_eq!(policy_client.get_threshold(&0, &vault_id), 2);
}

#[test]
fn add_context_rule_installs_venue_policy_cross_contract() {
    // The exact mechanism the whole design depends on: a smart account's
    // own add_context_rule() cross-calls policy.install() for every policy
    // in the map, in the same transaction. This proves Vault and
    // PolicyVenue actually compose, not just that each compiles alone.
    let e = Env::default();
    advance_to_realistic_ledger(&e);
    e.mock_all_auths();

    let (vault_id, vault, _admin) = deploy_vault(&e);
    let policy_venue_id = e.register(PolicyVenue, ());

    let admin = Address::generate(&e);
    let venue = Address::generate(&e);
    let cfg = VenueConfig {
        venues: Vec::from_array(&e, [venue.clone()]),
        per_call_cap: 1_000_000,
        epoch_cap: 5_000_000,
        epoch_length: 86400,
    };

    let mut policies: Map<Address, Val> = map![&e];
    policies.set(policy_venue_id.clone(), cfg.into_val(&e));

    let rule = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_yield"),
        &None,
        &Vec::from_array(&e, [Signer::Delegated(admin)]),
        &policies,
    );

    assert_eq!(rule.policies.len(), 1);
    assert_eq!(rule.policies.get_unchecked(0), policy_venue_id.clone());

    // The install actually landed in PolicyVenue's own storage, not just
    // the smart account's registry, query it back through its own client.
    let policy_client = refluo_policy_venue::PolicyVenueClient::new(&e, &policy_venue_id);
    let stored = policy_client.config(&vault_id, &rule.id);
    assert_eq!(stored.per_call_cap, 1_000_000);
}

#[test]
fn add_context_rule_installs_all_three_refluo_policies_on_separate_rules() {
    let e = Env::default();
    advance_to_realistic_ledger(&e);
    e.mock_all_auths();

    let (_vault_id, vault, _admin) = deploy_vault(&e);
    let policy_venue_id = e.register(PolicyVenue, ());
    let policy_recall_id = e.register(PolicyRecall, ());
    let policy_session_id = e.register(PolicySession, ());

    let admin = Signer::Delegated(Address::generate(&e));
    let keeper = Signer::Delegated(Address::generate(&e));
    let agent = Signer::Delegated(Address::generate(&e));
    let venue = Address::generate(&e);
    let facilitator = Address::generate(&e);

    // R_YIELD
    let venue_cfg = VenueConfig {
        venues: Vec::from_array(&e, [venue.clone()]),
        per_call_cap: 1_000_000,
        epoch_cap: 5_000_000,
        epoch_length: 86400,
    };
    let mut yield_policies: Map<Address, Val> = map![&e];
    yield_policies.set(policy_venue_id.clone(), venue_cfg.into_val(&e));
    let r_yield = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_yield"),
        &None,
        &Vec::from_array(&e, [admin.clone()]),
        &yield_policies,
    );

    // R_RECALL
    let recall_cfg = RecallConfig {
        venues: Vec::from_array(&e, [venue.clone()]),
        max_recalls_per_window: 6,
        window: 3600,
        min_interval_ledgers: 60,
    };
    let mut recall_policies: Map<Address, Val> = map![&e];
    recall_policies.set(policy_recall_id.clone(), recall_cfg.into_val(&e));
    let r_recall = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_recall"),
        &None,
        &Vec::from_array(&e, [keeper]),
        &recall_policies,
    );

    // R_AGENT_PAY
    let session_cfg = SessionConfig {
        expiry_ledger: 2_100_000,
        per_tx_cap: 1_000,
        epoch_cap: 10_000,
        epoch_length: 86400,
        dest_classes: Vec::from_array(&e, [DestClass::Facilitator(facilitator)]),
        amount_arg_index: 0,
    };
    let mut session_policies: Map<Address, Val> = map![&e];
    session_policies.set(policy_session_id.clone(), session_cfg.into_val(&e));
    let r_agent_pay = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_agent_pay"),
        &None,
        &Vec::from_array(&e, [agent]),
        &session_policies,
    );

    // R_ADMIN (bootstrapped at construction) plus the three just added.
    assert_eq!(vault.get_context_rules_count(), 4);
    assert_eq!(r_yield.policies.len(), 1);
    assert_eq!(r_recall.policies.len(), 1);
    assert_eq!(r_agent_pay.policies.len(), 1);
}

#[test]
fn refluo_disappears_admin_removes_all_policies_without_keeper_or_dashboard() {
    // The self-rescue guarantee: an admin, acting alone through the
    // vault's own management functions, can strip every policy-bearing
    // rule with zero involvement from the keeper, the SDK, or the
    // dashboard. Nothing here calls anything but the vault's own
    // SmartAccount client.
    let e = Env::default();
    advance_to_realistic_ledger(&e);
    e.mock_all_auths();

    let (vault_id, vault, admin_topology) = deploy_vault(&e);
    let policy_venue_id = e.register(PolicyVenue, ());
    let policy_recall_id = e.register(PolicyRecall, ());

    let admin = admin_topology.admin_a.clone();
    let keeper = Signer::Delegated(Address::generate(&e));
    let venue = Address::generate(&e);

    let venue_cfg = VenueConfig {
        venues: Vec::from_array(&e, [venue.clone()]),
        per_call_cap: 1_000_000,
        epoch_cap: 5_000_000,
        epoch_length: 86400,
    };
    let mut yield_policies: Map<Address, Val> = map![&e];
    yield_policies.set(policy_venue_id.clone(), venue_cfg.into_val(&e));
    let r_yield = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_yield"),
        &None,
        &Vec::from_array(&e, [admin.clone()]),
        &yield_policies,
    );

    let recall_cfg = RecallConfig {
        venues: Vec::from_array(&e, [venue]),
        max_recalls_per_window: 6,
        window: 3600,
        min_interval_ledgers: 60,
    };
    let mut recall_policies: Map<Address, Val> = map![&e];
    recall_policies.set(policy_recall_id.clone(), recall_cfg.into_val(&e));
    let r_recall = vault.add_context_rule(
        &ContextRuleType::Default,
        &SdkString::from_str(&e, "r_recall"),
        &None,
        &Vec::from_array(&e, [keeper]),
        &recall_policies,
    );

    // R_ADMIN (bootstrapped at construction) plus the two just added.
    assert_eq!(vault.get_context_rules_count(), 3);

    // Self-rescue: admin removes both policy-bearing rules directly.
    // remove_context_rule cross-calls try_uninstall on every attached
    // policy in the same call (verified against stellar-accounts source,
    // smart_account/storage.rs), no off-chain actor participates. This
    // test still uses mock_all_auths for the removal itself (proving the
    // uninstall wiring, not the 2-of-3 signature check); the real
    // multisig gate is proven live on testnet instead, see adr/0008 for
    // why MockAuth can't stand in for genuine multi-signer verification.
    vault.remove_context_rule(&r_yield.id);
    vault.remove_context_rule(&r_recall.id);

    // Both policy contracts confirm they were actually uninstalled, not
    // just unlinked from the vault's registry.
    let venue_client = refluo_policy_venue::PolicyVenueClient::new(&e, &policy_venue_id);
    let result = venue_client.try_config(&vault_id, &r_yield.id);
    assert!(
        result.is_err(),
        "policy-venue config must be gone after self-rescue uninstall"
    );

    let recall_client = refluo_policy_recall::PolicyRecallClient::new(&e, &policy_recall_id);
    let recall_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        recall_client.enforce(
            &Context::Contract(ContractContext {
                contract: Address::generate(&e),
                fn_name: symbol_short!("submit"),
                args: Vec::new(&e),
            }),
            &Vec::from_array(&e, [Signer::Delegated(Address::generate(&e))]),
            &r_recall,
            &Address::generate(&e),
        )
    }));
    assert!(
        recall_result.is_err(),
        "policy-recall must be fully uninstalled, not just unlinked"
    );
}
