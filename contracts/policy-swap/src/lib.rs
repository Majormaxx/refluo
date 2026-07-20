#![no_std]

//! SwapExecutor authorizes exactly one thing: a capped, rate-limited swap
//! from the Tier 0 reserve asset into XLM through a single allowlisted
//! Soroswap router, the fee-floor top-up path. The narrowness is the
//! security property, same reasoning as policy-recall: a compromised
//! keeper key routed through this contract can move funds only
//! token_in -> token_out, only to the vault itself, only through the one
//! allowlisted router, never anywhere else.
//!
//! The slippage floor is the part a compromised or buggy keeper cannot
//! fake: `amount_out_min` is checked against a floor this contract
//! computes itself from a real cross-contract read of OracleRouter's
//! live price, not trusted from the caller's own arguments. A caller
//! that supplies a looser `amount_out_min` than the oracle-derived floor
//! allows is rejected outright, bounding sandwich-attack damage to at
//! most `min_out_bps`'s complement of the swapped amount. Full spec
//! tracked internally, not in this repo.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Env, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

use refluo_common::Asset;

/// Mirrors oracle-router's OracleStatus/PriceQuote and its get_price entry
/// point. Not a shared dependency: oracle-router is isolated on
/// soroban-sdk 25.3 (adr/0005), policy-swap needs stellar-accounts'
/// 26.1.0 pin instead (same tension risk-engine already resolved,
/// adr/0006). Cross-contract calls are structural at the XDR level, so a
/// local mirror of the one method this contract calls is correct without
/// sharing a compilation unit.
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

#[allow(dead_code)]
#[contractclient(name = "OracleRouterClient")]
trait OracleRouterInterface {
    fn get_price(e: Env, asset: Asset) -> MirroredPriceQuote;
}

/// Mirrors Soroswap's real router `router_pair_for`, confirmed live via
/// `stellar contract info interface` against the deployed testnet router.
/// Used to verify the router's own internal token transfer (see
/// `enforce`'s second match arm) really targets Soroswap's own registered
/// pair for this exact token pair, not an address an attacker chose.
#[allow(dead_code)]
#[contractclient(name = "SoroswapRouterClient")]
trait SoroswapRouterInterface {
    fn router_pair_for(e: Env, token_a: Address, token_b: Address) -> Address;
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SwapConfig {
    pub router: Address,
    pub token_in: Address,
    pub token_out: Address,
    /// Cached at install time from each token's own real `decimals()`,
    /// not re-read on every enforce: decimals are immutable for a real
    /// deployed SAC/token contract, so caching carries no staleness risk.
    pub token_in_decimals: u32,
    pub token_out_decimals: u32,
    pub oracle_router: Address,
    pub oracle_asset: Asset,
    /// Must match OracleRouter's own ROUTER_DECIMALS for the configured
    /// asset (14 for the real deployment). Passed explicitly, not
    /// assumed, so this contract never hardcodes another contract's
    /// private constant.
    pub oracle_price_decimals: u32,
    pub per_call_cap: i128,
    pub epoch_cap: i128,
    pub epoch_length: u64,
    /// Minimum acceptable `amount_out_min` as bps of the oracle-fair value
    /// of `amount_in`, e.g. 9700 accepts up to 3% combined AMM spread,
    /// fee, and slippage. A caller-supplied `amount_out_min` below this
    /// floor is rejected outright, regardless of what the caller claims.
    pub min_out_bps: u32,
    /// `deadline` (unix seconds) must fall within this many seconds of
    /// the current ledger time: rejects a stale pre-signed intent
    /// lingering with an unreasonably distant deadline.
    pub max_deadline_window: u64,
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
    /// Soroswap's own real registered pair for (token_in, token_out),
    /// resolved once at install time (adr/0016). Read-only cache: cannot
    /// be re-resolved live inside `enforce`, the host's own reentrancy
    /// guard forbids calling back into `router` from a call already
    /// executing inside it (the router's internal token transfer is
    /// exactly such a call).
    Pair(Address, u32),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum SwapError {
    NotInitialized = 1,
    Unauthorized = 2,
    CapExceeded = 3,
    BadState = 4,
    AlreadyInstalled = 5,
    InvalidConfig = 6,
    OracleUnhealthy = 7,
    SlippageTooLoose = 8,
    DeadlineOutOfRange = 9,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SwapAuthorized {
    #[topic]
    pub smart_account: Address,
    pub amount_in: i128,
    pub amount_out_min: i128,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct SwapCapHit {
    #[topic]
    pub smart_account: Address,
    pub attempted: i128,
}

// Approximate Stellar ledger close time, same convention as policy-venue.
// Only controls TTL sizing headroom, never a cap or safety invariant.
const SECONDS_PER_LEDGER: u64 = 5;
const BPS_DENOM: i128 = 10_000;

#[contract]
pub struct PolicySwap;

#[contractimpl]
impl Policy for PolicySwap {
    type AccountParams = SwapConfig;

    fn install(
        e: &Env,
        install_params: SwapConfig,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        let c = &install_params;
        if c.token_in == c.token_out
            || c.per_call_cap <= 0
            || c.epoch_cap < c.per_call_cap
            || c.epoch_length == 0
            || c.min_out_bps == 0
            || c.min_out_bps > 10_000
            || c.oracle_price_decimals == 0
            || c.max_deadline_window == 0
        {
            panic_with_error!(e, SwapError::InvalidConfig);
        }

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, SwapError::AlreadyInstalled);
        }

        // Resolved once, here, not trusted from the caller and never
        // re-resolved live inside enforce: the host's reentrancy guard
        // forbids calling back into `router` from inside a call already
        // executing there (adr/0016).
        let pair =
            SoroswapRouterClient::new(e, &c.router).router_pair_for(&c.token_in, &c.token_out);
        e.storage().persistent().set(
            &DataKey::Pair(smart_account.clone(), context_rule.id),
            &pair,
        );

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
            panic_with_error!(e, SwapError::Unauthorized);
        }

        let cfg: SwapConfig = e
            .storage()
            .persistent()
            .get(&DataKey::Config(smart_account.clone(), context_rule.id))
            .unwrap_or_else(|| panic_with_error!(e, SwapError::NotInitialized));

        match context {
            // The real Soroswap router's `swap_exact_tokens_for_tokens`
            // requires the vault's own authorization twice within one
            // transaction: once for the router call itself, once again
            // for its internal `token_in.transfer(vault, pair, amount)`
            // sub-call, confirmed live (adr/0016). Soroban batches both
            // into this same context_rule, calling `enforce` once per
            // context, so both arms below are real, expected traffic for
            // a single genuine swap, not two independent authorizations.
            Context::Contract(ContractContext {
                contract,
                fn_name,
                args,
            }) if contract == cfg.router
                && fn_name == Symbol::new(e, "swap_exact_tokens_for_tokens") =>
            {
                let (amount_in, amount_out_min) =
                    enforce_swap_exact_tokens(e, &cfg, &args, &smart_account);

                bump_epoch_spend(e, &smart_account, context_rule.id, amount_in, &cfg);

                SwapAuthorized {
                    smart_account,
                    amount_in,
                    amount_out_min,
                }
                .publish(e);
            }
            Context::Contract(ContractContext {
                contract,
                fn_name,
                args,
            }) if contract == cfg.token_in && fn_name == Symbol::new(e, "transfer") => {
                enforce_token_in_transfer(e, &cfg, &args, &smart_account, context_rule.id);
            }
            _ => panic_with_error!(e, SwapError::Unauthorized),
        }
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let key = DataKey::Config(smart_account.clone(), context_rule.id);
        if !e.storage().persistent().has(&key) {
            panic_with_error!(e, SwapError::NotInitialized);
        }
        e.storage().persistent().remove(&key);
        e.storage()
            .persistent()
            .remove(&DataKey::Pair(smart_account.clone(), context_rule.id));
        e.storage()
            .persistent()
            .remove(&DataKey::LastWriteEpoch(smart_account, context_rule.id));
    }
}

#[contractimpl]
impl PolicySwap {
    /// Read-only status query, not part of the Policy trait. Mirrors
    /// policy-venue's own `config()`, used by tests and the planned
    /// dashboard/SDK to confirm install/uninstall touched storage.
    pub fn config(e: Env, smart_account: Address, context_rule_id: u32) -> SwapConfig {
        e.storage()
            .persistent()
            .get(&DataKey::Config(smart_account, context_rule_id))
            .unwrap_or_else(|| panic_with_error!(e, SwapError::NotInitialized))
    }
}

/// Soroswap router's real `swap_exact_tokens_for_tokens(amount_in,
/// amount_out_min, path, to, deadline)`. Arg order verified live against
/// the deployed testnet router via `stellar contract info interface`, not
/// assumed from docs. Every check here is defense in depth beyond what
/// the router itself enforces: path shape, destination, cap, and the
/// oracle-derived slippage floor.
fn enforce_swap_exact_tokens(
    e: &Env,
    cfg: &SwapConfig,
    args: &Vec<Val>,
    smart_account: &Address,
) -> (i128, i128) {
    let amount_in = args
        .get(0)
        .and_then(|v| i128::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let amount_out_min = args
        .get(1)
        .and_then(|v| i128::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let path = args
        .get(2)
        .and_then(|v| Vec::<Address>::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let to = args
        .get(3)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let deadline = args
        .get(4)
        .and_then(|v| u64::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));

    // Direct pair only: no multi-hop path, so a compromised keeper can
    // never route through an unvetted intermediate asset.
    if path.len() != 2
        || path.get(0) != Some(cfg.token_in.clone())
        || path.get(1) != Some(cfg.token_out.clone())
    {
        panic_with_error!(e, SwapError::Unauthorized);
    }

    if &to != smart_account {
        panic_with_error!(e, SwapError::Unauthorized);
    }

    if amount_in <= 0 || amount_in > cfg.per_call_cap {
        panic_with_error!(e, SwapError::CapExceeded);
    }

    let now = e.ledger().timestamp();
    if deadline < now || deadline > now.saturating_add(cfg.max_deadline_window) {
        panic_with_error!(e, SwapError::DeadlineOutOfRange);
    }

    let min_acceptable_out = oracle_derived_min_out(e, cfg, amount_in);
    if amount_out_min < min_acceptable_out {
        panic_with_error!(e, SwapError::SlippageTooLoose);
    }

    (amount_in, amount_out_min)
}

/// SEP-41 `transfer(from, to, amount)`, the router's own internal pull of
/// `token_in` from the vault. This never bumps epoch spend or publishes
/// `SwapAuthorized` again, the paired primary context already did that
/// for the same real transaction. What this arm has to prevent: an
/// attacker submitting *only* this context, with no accompanying
/// `swap_exact_tokens_for_tokens` context, to smuggle an arbitrary-
/// destination transfer of the vault's `token_in` past this policy.
/// `to` is checked against the real pair address `install()` resolved and
/// cached (adr/0016): a live `router_pair_for` call here would re-enter
/// `router`, which the host forbids since this call is already executing
/// inside it.
fn enforce_token_in_transfer(
    e: &Env,
    cfg: &SwapConfig,
    args: &Vec<Val>,
    smart_account: &Address,
    rule_id: u32,
) {
    let from = args
        .get(0)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let to = args
        .get(1)
        .and_then(|v| Address::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));
    let amount = args
        .get(2)
        .and_then(|v| i128::try_from_val(e, &v).ok())
        .unwrap_or_else(|| panic_with_error!(e, SwapError::Unauthorized));

    if &from != smart_account {
        panic_with_error!(e, SwapError::Unauthorized);
    }
    if amount <= 0 || amount > cfg.per_call_cap {
        panic_with_error!(e, SwapError::CapExceeded);
    }

    let real_pair: Address = e
        .storage()
        .persistent()
        .get(&DataKey::Pair(smart_account.clone(), rule_id))
        .unwrap_or_else(|| panic_with_error!(e, SwapError::NotInitialized));
    if to != real_pair {
        panic_with_error!(e, SwapError::Unauthorized);
    }
}

/// Real cross-contract read of OracleRouter's live price, never a value
/// the caller supplies. `amount_in` is assumed pegged ~1 USD per unit
/// (Tier 0's reserve asset), the same peg assumption risk-engine already
/// makes for its own USDC balance checks. No oracle exists for a USD
/// stablecoin's own price in this workspace, consistent with that
/// existing convention.
///
/// expected_out (token_out units) = amount_in
///     * 10^oracle_price_decimals * 10^token_out_decimals
///     / (quote.price * 10^token_in_decimals)
/// then floored to `min_out_bps` of that.
fn oracle_derived_min_out(e: &Env, cfg: &SwapConfig, amount_in: i128) -> i128 {
    let quote = OracleRouterClient::new(e, &cfg.oracle_router).get_price(&cfg.oracle_asset);

    if !matches!(
        quote.status,
        MirroredOracleStatus::Healthy | MirroredOracleStatus::OneFeed
    ) {
        panic_with_error!(e, SwapError::OracleUnhealthy);
    }
    if quote.price <= 0 {
        panic_with_error!(e, SwapError::BadState);
    }

    let scale_num = pow10(cfg.oracle_price_decimals)
        .checked_mul(pow10(cfg.token_out_decimals))
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState));
    let scale_den = quote
        .price
        .checked_mul(pow10(cfg.token_in_decimals))
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState));

    let expected_out = amount_in
        .checked_mul(scale_num)
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState))
        .checked_div(scale_den)
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState));

    expected_out
        .checked_mul(cfg.min_out_bps as i128)
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState))
        .checked_div(BPS_DENOM)
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState))
}

fn pow10(exp: u32) -> i128 {
    10i128.pow(exp)
}

/// Fail-closed epoch counter, identical pattern to policy-venue's
/// `bump_epoch_spend` (adr/0003): a missing current-epoch temporary
/// counter after a prior write reverts as BadState instead of silently
/// resetting to zero spend mid-epoch.
fn bump_epoch_spend(
    e: &Env,
    smart_account: &Address,
    rule_id: u32,
    amount: i128,
    cfg: &SwapConfig,
) {
    let now = e.ledger().timestamp();
    let epoch_index = now / cfg.epoch_length;

    let epoch_key = DataKey::EpochSpend(smart_account.clone(), rule_id, epoch_index);
    let last_write_key = DataKey::LastWriteEpoch(smart_account.clone(), rule_id);

    let last_write_epoch: Option<u64> = e.storage().persistent().get(&last_write_key);
    let temp_spend: Option<EpochSpend> = e.storage().temporary().get(&epoch_key);

    let current_spent = match (&last_write_epoch, &temp_spend) {
        (Some(last), None) if *last == epoch_index => {
            panic_with_error!(e, SwapError::BadState)
        }
        (_, Some(es)) => es.spent,
        _ => 0,
    };

    let new_spent = current_spent
        .checked_add(amount)
        .unwrap_or_else(|| panic_with_error!(e, SwapError::BadState));

    if new_spent > cfg.epoch_cap {
        SwapCapHit {
            smart_account: smart_account.clone(),
            attempted: new_spent,
        }
        .publish(e);
        panic_with_error!(e, SwapError::CapExceeded);
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
        testutils::{Address as _, Ledger},
        IntoVal, String as SdkString,
    };
    use stellar_accounts::smart_account::ContextRuleType;

    #[contract]
    struct MockOracleRouter;

    #[contracttype]
    pub enum MockKey {
        Quote,
    }

    #[contractimpl]
    impl MockOracleRouter {
        pub fn set_quote(e: Env, q: MirroredPriceQuote) {
            e.storage().persistent().set(&MockKey::Quote, &q);
        }
    }

    #[contractimpl]
    impl OracleRouterInterface for MockOracleRouter {
        fn get_price(e: Env, _asset: Asset) -> MirroredPriceQuote {
            e.storage()
                .persistent()
                .get(&MockKey::Quote)
                .unwrap_or_else(|| panic_with_error!(e, SwapError::NotInitialized))
        }
    }

    #[contract]
    struct MockSoroswapRouter;

    #[contracttype]
    pub enum MockRouterKey {
        Pair,
    }

    #[contractimpl]
    impl MockSoroswapRouter {
        pub fn set_pair_for(e: Env, pair: Address) {
            e.storage().persistent().set(&MockRouterKey::Pair, &pair);
        }
    }

    #[contractimpl]
    impl SoroswapRouterInterface for MockSoroswapRouter {
        fn router_pair_for(e: Env, _token_a: Address, _token_b: Address) -> Address {
            e.storage()
                .persistent()
                .get(&MockRouterKey::Pair)
                .unwrap_or_else(|| panic_with_error!(e, SwapError::NotInitialized))
        }
    }

    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

    struct Fixture<'a> {
        client: PolicySwapClient<'a>,
        smart_account: Address,
        router: Address,
        token_in: Address,
        token_out: Address,
        oracle: MockOracleRouterClient<'a>,
        /// The mock router's default resolvable pair, set during setup()
        /// since install() now resolves it live (adr/0016): every install
        /// needs a real answer, not just the tests that exercise the
        /// transfer-context path directly.
        pair: Address,
    }

    // XLM at exactly $0.10, 14 decimals, matching OracleRouter's real
    // ROUTER_DECIMALS convention.
    fn healthy_quote(e: &Env, price: i128) -> MirroredPriceQuote {
        MirroredPriceQuote {
            price,
            timestamp: e.ledger().timestamp(),
            status: MirroredOracleStatus::Healthy,
            conservative_low: price,
            conservative_high: price,
        }
    }

    fn setup(e: &Env) -> Fixture<'_> {
        advance_to_realistic_ledger(e);
        let contract_id = e.register(PolicySwap, ());
        let client = PolicySwapClient::new(e, &contract_id);
        let smart_account = Address::generate(e);
        // A real registered contract, not a bare generated address: the
        // transfer-context arm of enforce() makes a real cross-contract
        // call to router_pair_for, so tests exercising that path need a
        // real callable mock, same reasoning as MockOracleRouter above.
        let router = e.register(MockSoroswapRouter, ());
        let token_in = Address::generate(e);
        let token_out = Address::generate(e);
        let oracle_id = e.register(MockOracleRouter, ());
        let oracle = MockOracleRouterClient::new(e, &oracle_id);
        oracle.set_quote(&healthy_quote(e, 10_000_000_000_000)); // $0.10 * 1e14
        let pair = Address::generate(e);
        MockSoroswapRouterClient::new(e, &router).set_pair_for(&pair);
        Fixture {
            client,
            smart_account,
            router,
            token_in,
            token_out,
            oracle,
            pair,
        }
    }

    fn rule(e: &Env, id: u32) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::Default,
            name: SdkString::from_str(e, "r_swap"),
            signers: Vec::new(e),
            signer_ids: Vec::new(e),
            policies: Vec::new(e),
            policy_ids: Vec::new(e),
            valid_until: None,
        }
    }

    fn cfg(
        e: &Env,
        f: &Fixture,
        per_call_cap: i128,
        epoch_cap: i128,
        min_out_bps: u32,
    ) -> SwapConfig {
        SwapConfig {
            router: f.router.clone(),
            token_in: f.token_in.clone(),
            token_out: f.token_out.clone(),
            token_in_decimals: 7,
            token_out_decimals: 7,
            oracle_router: f.oracle.address.clone(),
            oracle_asset: Asset::Other(soroban_sdk::Symbol::new(e, "XLM")),
            oracle_price_decimals: 14,
            per_call_cap,
            epoch_cap,
            epoch_length: 86400,
            min_out_bps,
            max_deadline_window: 300,
        }
    }

    fn signers(e: &Env) -> Vec<Signer> {
        Vec::from_array(e, [Signer::Delegated(Address::generate(e))])
    }

    #[allow(clippy::too_many_arguments)]
    fn swap_context(
        e: &Env,
        router: &Address,
        token_in: &Address,
        token_out: &Address,
        amount_in: i128,
        amount_out_min: i128,
        to: &Address,
        deadline: u64,
    ) -> Context {
        let mut args = Vec::new(e);
        args.push_back(amount_in.into_val(e));
        args.push_back(amount_out_min.into_val(e));
        let path = Vec::from_array(e, [token_in.clone(), token_out.clone()]);
        args.push_back(path.into_val(e));
        args.push_back(to.into_val(e));
        args.push_back(deadline.into_val(e));
        Context::Contract(ContractContext {
            contract: router.clone(),
            fn_name: Symbol::new(e, "swap_exact_tokens_for_tokens"),
            args,
        })
    }

    fn transfer_context(
        e: &Env,
        token_in: &Address,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> Context {
        let mut args = Vec::new(e);
        args.push_back(from.into_val(e));
        args.push_back(to.into_val(e));
        args.push_back(amount.into_val(e));
        Context::Contract(ContractContext {
            contract: token_in.clone(),
            fn_name: Symbol::new(e, "transfer"),
            args,
        })
    }

    // amount_in 100 USDC (7 decimals) at $0.10/XLM should expect ~1000 XLM
    // out (7 decimals): 1_000_000_000 stroops * 10 = 10_000_000_000.
    const AMOUNT_IN_100_USDC: i128 = 1_000_000_000;
    const EXPECTED_OUT_AT_10C: i128 = 10_000_000_000;

    #[test]
    fn enforce_allows_swap_within_cap_and_slippage_floor() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let min_out = EXPECTED_OUT_AT_10C * 97 / 100;
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now + 60,
        );
        f.client
            .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
    }

    #[test]
    fn enforce_rejects_amount_out_min_below_oracle_floor() {
        // Simulates the sandwich attack: a compromised keeper sets
        // amount_out_min far below fair value to let a sandwiching bot
        // extract the difference. Must be rejected regardless of what
        // the caller claims the swap is worth.
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let too_loose_min_out = EXPECTED_OUT_AT_10C / 2; // 50% slippage
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            too_loose_min_out,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_oracle_degraded() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        f.oracle.set_quote(&MirroredPriceQuote {
            price: 10_000_000_000_000,
            timestamp: e.ledger().timestamp(),
            status: MirroredOracleStatus::Degraded,
            conservative_low: 10_000_000_000_000,
            conservative_high: 10_000_000_000_000,
        });
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_router_not_allowlisted() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let other_router = Address::generate(&e);
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &other_router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_multi_hop_path() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let intermediate = Address::generate(&e);
        let mut args = Vec::new(&e);
        args.push_back(AMOUNT_IN_100_USDC.into_val(&e));
        args.push_back(1i128.into_val(&e));
        let path = Vec::from_array(&e, [f.token_in.clone(), intermediate, f.token_out.clone()]);
        args.push_back(path.into_val(&e));
        args.push_back(f.smart_account.into_val(&e));
        args.push_back((e.ledger().timestamp() + 60).into_val(&e));
        let ctx = Context::Contract(ContractContext {
            contract: f.router.clone(),
            fn_name: Symbol::new(&e, "swap_exact_tokens_for_tokens"),
            args,
        });
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_wrong_token_pair() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let wrong_out = Address::generate(&e);
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &wrong_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_destination_other_than_vault() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let attacker = Address::generate(&e);
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &attacker,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_amount_over_per_call_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC + 1,
            EXPECTED_OUT_AT_10C,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_deadline_in_the_past() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now - 1,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_deadline_too_far_in_future() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now + 10_000,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_epoch_cap_never_exceeded_across_multiple_calls() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 2, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let min_out = EXPECTED_OUT_AT_10C * 97 / 100;
        let now = e.ledger().timestamp();
        for _ in 0..2 {
            let ctx = swap_context(
                &e,
                &f.router,
                &f.token_in,
                &f.token_out,
                AMOUNT_IN_100_USDC,
                min_out,
                &f.smart_account,
                now + 60,
            );
            f.client
                .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        }

        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_epoch_counter_resets_on_new_epoch() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let mut c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC, 9_700);
        c.epoch_length = 100;
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let min_out = EXPECTED_OUT_AT_10C * 97 / 100;
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now + 60,
        );
        f.client
            .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);

        let ctx2 = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now + 60,
        );
        assert!(f
            .client
            .try_enforce(&ctx2, &signers(&e), &rule(&e, 1), &f.smart_account)
            .is_err());

        e.ledger().with_mut(|l| l.timestamp += 200);
        let now2 = e.ledger().timestamp();
        let ctx3 = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now2 + 60,
        );
        f.client
            .enforce(&ctx3, &signers(&e), &rule(&e, 1), &f.smart_account);
    }

    #[test]
    fn install_rejects_zero_min_out_bps() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let mut c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        c.min_out_bps = 0;
        let result = f.client.try_install(&c, &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn install_rejects_min_out_bps_over_10000() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let mut c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        c.min_out_bps = 10_001;
        let result = f.client.try_install(&c, &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn install_rejects_token_in_equals_token_out() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let mut c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        c.token_out = c.token_in.clone();
        let result = f.client.try_install(&c, &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn uninstall_removes_config_and_enforce_then_fails() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);
        f.client.uninstall(&rule(&e, 1), &f.smart_account);

        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            1,
            &f.smart_account,
            now + 60,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    // ################## router's internal token_in transfer context ##################
    // Confirmed live (adr/0016): Soroswap's real router requires the
    // vault's own authorization twice within one transaction, once for
    // swap_exact_tokens_for_tokens itself, once again for its internal
    // token_in.transfer(vault, pair, amount) sub-call. These tests cover
    // that second context in isolation, the shape a compromised keeper
    // would submit alone if it could, with no paired swap context at all.

    #[test]
    fn enforce_allows_token_in_transfer_to_the_real_registered_pair() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let ctx = transfer_context(
            &e,
            &f.token_in,
            &f.smart_account,
            &f.pair,
            AMOUNT_IN_100_USDC,
        );
        f.client
            .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
    }

    #[test]
    fn enforce_rejects_token_in_transfer_to_anywhere_but_the_real_pair() {
        // The core security property this arm exists for: an attacker
        // submitting only this context, no paired swap context, must
        // never be able to redirect token_in anywhere but the real pair
        // install() resolved and cached (f.pair).
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let attacker_destination = Address::generate(&e);
        let ctx = transfer_context(
            &e,
            &f.token_in,
            &f.smart_account,
            &attacker_destination,
            AMOUNT_IN_100_USDC,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_token_in_transfer_not_from_the_vault() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let not_vault = Address::generate(&e);
        let ctx = transfer_context(&e, &f.token_in, &not_vault, &f.pair, AMOUNT_IN_100_USDC);
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_rejects_token_in_transfer_over_per_call_cap() {
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        let ctx = transfer_context(
            &e,
            &f.token_in,
            &f.smart_account,
            &f.pair,
            AMOUNT_IN_100_USDC + 1,
        );
        let result = f
            .client
            .try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        assert!(result.is_err());
    }

    #[test]
    fn enforce_token_in_transfer_never_bumps_epoch_spend() {
        // The primary swap_exact_tokens_for_tokens context is what tracks
        // epoch spend; this arm must not double-count when both contexts
        // land for the same real swap.
        let e = Env::default();
        e.mock_all_auths();
        let f = setup(&e);
        let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC, 9_700);
        f.client.install(&c, &rule(&e, 1), &f.smart_account);

        for _ in 0..3 {
            let ctx = transfer_context(
                &e,
                &f.token_in,
                &f.smart_account,
                &f.pair,
                AMOUNT_IN_100_USDC,
            );
            f.client
                .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
        }

        // If this arm bumped epoch spend, the epoch_cap (== per_call_cap,
        // one swap's worth) would already be exhausted after the first
        // call; a real primary-context swap must still succeed.
        let min_out = EXPECTED_OUT_AT_10C * 97 / 100;
        let now = e.ledger().timestamp();
        let ctx = swap_context(
            &e,
            &f.router,
            &f.token_in,
            &f.token_out,
            AMOUNT_IN_100_USDC,
            min_out,
            &f.smart_account,
            now + 60,
        );
        f.client
            .enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
    }

    // ################## PROPERTY TESTS ##################

    proptest! {
        #[test]
        fn prop_amount_out_min_below_floor_always_rejected(
            price in 1_000_000_000_000i128..=100_000_000_000_000i128, // $0.01 to $1.00
            amount_in in 1_000_000i128..=AMOUNT_IN_100_USDC,
            shortfall_bps in 1u32..=9_699, // strictly below the 97% floor used in cfg()
        ) {
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let f = setup(&e);
            f.oracle.set_quote(&healthy_quote(&e, price));
            let c = cfg(&e, &f, AMOUNT_IN_100_USDC, AMOUNT_IN_100_USDC * 10, 9_700);
            f.client.install(&c, &rule(&e, 1), &f.smart_account);

            let expected_out = amount_in * pow10(14) * pow10(7) / (price * pow10(7));
            let attacker_min_out = expected_out * shortfall_bps as i128 / BPS_DENOM;

            let now = e.ledger().timestamp();
            let ctx = swap_context(&e, &f.router, &f.token_in, &f.token_out, amount_in, attacker_min_out, &f.smart_account, now + 60);
            let result = f.client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
            prop_assert!(result.is_err());
        }

        #[test]
        fn prop_epoch_spend_never_exceeds_cap(
            amounts in proptest::collection::vec(1_000_000i128..=5_000_000i128, 1..8),
        ) {
            let e = Env::default();
            advance_to_realistic_ledger(&e);
            e.mock_all_auths();
            let f = setup(&e);
            let epoch_cap = 12_000_000i128;
            let c = cfg(&e, &f, 5_000_000, epoch_cap, 1); // min_out_bps=1: isolate the cap invariant
            f.client.install(&c, &rule(&e, 1), &f.smart_account);

            let mut accepted_total: i128 = 0;
            for amount in amounts {
                let now = e.ledger().timestamp();
                let ctx = swap_context(&e, &f.router, &f.token_in, &f.token_out, amount, 1, &f.smart_account, now + 60);
                let result = f.client.try_enforce(&ctx, &signers(&e), &rule(&e, 1), &f.smart_account);
                if result.is_ok() {
                    accepted_total += amount;
                }
                prop_assert!(accepted_total <= epoch_cap);
            }
        }
    }
}
