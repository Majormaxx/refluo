#![no_main]

//! Fuzzes the real, deployed `PolicyVenue::enforce()` entry point against
//! an adversarial Blend V2 `submit()` request list: arbitrary
//! `request_type` values across the full u32 range, going beyond the
//! known enum values plus a handful of hand-picked rejects, and arbitrary
//! i128 amounts including the extremes. The PRD calls for cargo-fuzz on
//! the Blend `submit()` decoder specifically; this drives the actual
//! decode path (`Vec::<BlendRequest>::try_from_val` then the
//! request_type match) through the real contract, not an extracted
//! fragment of it, so a surprise in how the real Client/Env layer
//! marshals the args would surface too, beyond just a bug in the match
//! arms. Controlled rejections
//! (`panic_with_error!`, surfaced as `Err` via `try_enforce`) are the
//! expected, correct outcome for a bad `request_type` and are not
//! failures; only a genuine crash (index panic, overflow trap, host
//! error) is a bug for cargo-fuzz to report. See adr/0009.

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use refluo_common::BlendRequest;
use refluo_policy_venue::{PolicyVenue, PolicyVenueClient, VenueConfig};
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::Address as _,
    Address, Env, IntoVal, String as SdkString, Vec,
};
use stellar_accounts::smart_account::{ContextRule, ContextRuleType};

#[derive(Debug, Arbitrary)]
struct FuzzRequest {
    request_type: u32,
    amount: i128,
}

#[derive(Debug, Arbitrary)]
struct FuzzInput {
    requests: std::vec::Vec<FuzzRequest>,
    per_call_cap: i128,
    epoch_cap: i128,
}

fuzz_target!(|input: FuzzInput| {
    // Bound the request count; the point is exercising the decode path
    // under adversarial content, not an unbounded-allocation DoS the
    // real transaction size limit already rules out on-chain.
    if input.requests.len() > 64 {
        return;
    }
    // install() itself requires epoch_cap >= per_call_cap > 0; keep both
    // positive and ordered so every run reaches the enforce() path under
    // test instead of bouncing off install-time validation every time.
    let per_call_cap = input.per_call_cap.unsigned_abs() as i128 % 1_000_000_000 + 1;
    let epoch_cap = per_call_cap + (input.epoch_cap.unsigned_abs() as i128 % 1_000_000_000);

    let e = Env::default();
    e.mock_all_auths();

    let contract_id = e.register(PolicyVenue, ());
    let client = PolicyVenueClient::new(&e, &contract_id);
    let smart_account = Address::generate(&e);
    let venue = Address::generate(&e);

    let cfg = VenueConfig {
        venues: Vec::from_array(&e, [venue.clone()]),
        per_call_cap,
        epoch_cap,
        epoch_length: 86400,
    };
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::Default,
        name: SdkString::from_str(&e, "r_yield"),
        signers: Vec::new(&e),
        signer_ids: Vec::new(&e),
        policies: Vec::new(&e),
        policy_ids: Vec::new(&e),
        valid_until: None,
    };
    if client.try_install(&cfg, &rule, &smart_account).is_err() {
        return;
    }

    let mut requests: Vec<BlendRequest> = Vec::new(&e);
    for r in &input.requests {
        requests.push_back(BlendRequest {
            request_type: r.request_type,
            address: Address::generate(&e),
            amount: r.amount,
        });
    }

    let mut args = Vec::new(&e);
    args.push_back(smart_account.into_val(&e));
    args.push_back(smart_account.into_val(&e));
    args.push_back(smart_account.into_val(&e));
    args.push_back(requests.into_val(&e));
    let context = Context::Contract(ContractContext {
        contract: venue,
        fn_name: symbol_short!("submit"),
        args,
    });

    // Any outcome is fine, panic_with_error rejections included, that's
    // this policy correctly refusing a bad request. What cargo-fuzz is
    // watching for is the process aborting some other way: an
    // unreachable panic message, an overflow trap outside the checked
    // arithmetic already in enforce_blend_submit, anything not a clean
    // contract-level error.
    let signers = Vec::from_array(
        &e,
        [stellar_accounts::smart_account::Signer::Delegated(
            Address::generate(&e),
        )],
    );
    let _ = client.try_enforce(&context, &signers, &rule, &smart_account);
});
