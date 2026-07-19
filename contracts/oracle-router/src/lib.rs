#![no_std]

//! OracleRouter — every other Refluo module reads price through here, never
//! feeds directly. Uses `sep-40-oracle`'s standard client for both Reflector
//! and RedStone (see adr/0005): both implement structurally identical
//! Asset/PriceData types, verified from source, so one client works for
//! both providers rather than hand-rolling two integrations.
//!
//! Staleness is checked per-feed before divergence is computed, so a stale
//! feed removes itself from quorum instead of falsely tripping the
//! divergence breaker. The rate-of-change clamp only exempts a candidate
//! price when both feeds independently confirm the move within the soft
//! divergence band — that's the specific rule a naive variance check
//! misses: a single-feed manipulated tick must never pass, and two
//! honestly-diverging feeds between heartbeats must never falsely trip.

use sep_40_oracle::{Asset, PriceData as Sep40PriceData, PriceFeedClient};
use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Env,
};

/// Mirrors health-monitor's real `pause(guardian: Address)` (see adr/0010).
/// Not a shared dependency: health-monitor is on soroban-sdk 26.1.0,
/// oracle-router is isolated on 25.3 (adr/0005), and cross-contract calls
/// are structural at the XDR level, so a local mirror of the one method
/// this contract calls is correct without sharing a compilation unit.
#[allow(dead_code)]
#[contractclient(name = "HealthMonitorClient")]
trait HealthMonitorInterface {
    fn pause(e: Env, guardian: Address);
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OracleStatus {
    Healthy = 0,
    OneFeed = 1,
    Degraded = 2,
    HardStop = 3,
}

/// Local mirror of refluo-common's PriceQuote, not a shared dependency —
/// oracle-router is isolated on its own soroban-sdk version (adr/0005), so
/// refluo-common (built against 26.1.0) is not importable here.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceQuote {
    /// Scaled to ROUTER_DECIMALS.
    pub price: i128,
    pub timestamp: u64,
    pub status: OracleStatus,
    /// min(feeds) for collateral-side valuation.
    pub conservative_low: i128,
    /// max(feeds) for liability-side valuation.
    pub conservative_high: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct AssetOracleConfig {
    pub primary_feed: Address,
    /// The Asset key to pass to the primary feed's own lastprice()/prices()
    /// calls — NOT necessarily the router's logical asset key. Confirmed on
    /// real testnet: Reflector keys XLM as `Other(Symbol("XLM"))` while
    /// RedStone keys the same asset as `Stellar(<SAC address>)`. Each
    /// provider's own addressing scheme has to be stored per-feed; a
    /// single shared Asset value across both calls is wrong.
    pub primary_asset: Asset,
    pub secondary_feed: Address,
    pub secondary_asset: Asset,
    pub max_staleness_primary: u64,
    pub max_staleness_secondary: u64,
    pub twap_periods: u32,
    pub divergence_soft: u32,
    pub divergence_hard: u32,
    pub max_roc_per_update: u32,
}

#[contracttype]
pub enum DataKey {
    Config(Asset),
    LastAccepted(Asset),
    OneFeedSince(Asset),
}

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RouterError {
    NotInitialized = 1,
    InvalidConfig = 2,
}

#[contractevent]
#[derive(Clone)]
pub struct PxWarn {
    #[topic]
    pub asset: Asset,
    pub primary: i128,
    pub secondary: i128,
    pub divergence_bps: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct PxDegraded {
    #[topic]
    pub asset: Asset,
}

#[contractevent]
#[derive(Clone)]
pub struct PxRocReject {
    #[topic]
    pub asset: Asset,
    pub old: i128,
    pub new: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct PxRecovered {
    #[topic]
    pub asset: Asset,
}

/// Matches Reflector's decimals, the primary feed. RedStone's decimals()
/// is fresh-read and rescaled to this on every call — never cached,
/// RedStone's own contract documents it as mutable by the feed owner.
const ROUTER_DECIMALS: u32 = 14;
const BPS_DENOM: i128 = 10_000;
/// Escalate OneFeed to Degraded after this long with no second feed.
const ONE_FEED_DEGRADE_AFTER: u64 = 1800;
/// History cap on Reflector Pulse; never configure twap_periods near it.
const MAX_TWAP_PERIODS: u32 = 64;

#[contract]
pub struct OracleRouter;

#[contractimpl]
impl OracleRouter {
    /// Will be timelock-gated once the timelock contract is integrated. No
    /// admin check yet at this scaffold stage.
    pub fn set_config(e: Env, asset: Asset, cfg: AssetOracleConfig) {
        if cfg.twap_periods == 0 || cfg.twap_periods > MAX_TWAP_PERIODS {
            panic_with_error!(e, RouterError::InvalidConfig);
        }
        if cfg.divergence_soft >= cfg.divergence_hard {
            panic_with_error!(e, RouterError::InvalidConfig);
        }
        if cfg.max_staleness_primary == 0 || cfg.max_staleness_secondary == 0 {
            panic_with_error!(e, RouterError::InvalidConfig);
        }
        e.storage().persistent().set(&DataKey::Config(asset), &cfg);
    }

    pub fn config(e: Env, asset: Asset) -> AssetOracleConfig {
        e.storage()
            .persistent()
            .get(&DataKey::Config(asset))
            .unwrap_or_else(|| panic_with_error!(e, RouterError::NotInitialized))
    }

    /// Main read. Every other Refluo contract calls this, never a feed
    /// directly.
    pub fn get_price(e: Env, asset: Asset) -> PriceQuote {
        let cfg = Self::config(e.clone(), asset.clone());
        let now = e.ledger().timestamp();

        let primary = fetch_fresh(
            &e,
            &cfg.primary_feed,
            &cfg.primary_asset,
            cfg.max_staleness_primary,
            now,
        );
        let secondary = fetch_fresh(
            &e,
            &cfg.secondary_feed,
            &cfg.secondary_asset,
            cfg.max_staleness_secondary,
            now,
        );

        let last_accepted: Option<PriceQuote> = e
            .storage()
            .persistent()
            .get(&DataKey::LastAccepted(asset.clone()));

        let quote = match (primary, secondary) {
            (Some(p), Some(s)) => {
                resolve_both_available(&e, &cfg, &asset, p, s, now, last_accepted.as_ref())
            }
            (Some(f), None) | (None, Some(f)) => {
                resolve_one_available(&e, &cfg, &asset, f, now, last_accepted.as_ref())
            }
            (None, None) => PriceQuote {
                price: last_accepted.as_ref().map(|q| q.price).unwrap_or(0),
                timestamp: now,
                status: OracleStatus::HardStop,
                conservative_low: last_accepted
                    .as_ref()
                    .map(|q| q.conservative_low)
                    .unwrap_or(0),
                conservative_high: last_accepted
                    .as_ref()
                    .map(|q| q.conservative_high)
                    .unwrap_or(0),
            },
        };

        let was_tripped = matches!(
            last_accepted.as_ref().map(|q| q.status),
            Some(OracleStatus::Degraded) | Some(OracleStatus::HardStop)
        );
        let now_healthy = matches!(quote.status, OracleStatus::Healthy | OracleStatus::OneFeed);
        if was_tripped && now_healthy {
            PxRecovered {
                asset: asset.clone(),
            }
            .publish(&e);
        }

        if now_healthy {
            e.storage()
                .persistent()
                .set(&DataKey::LastAccepted(asset.clone()), &quote);
        }
        if !matches!(quote.status, OracleStatus::OneFeed) {
            e.storage()
                .persistent()
                .remove(&DataKey::OneFeedSince(asset));
        }

        quote
    }

    /// Permissionless crank: anyone can call this, and on a genuinely
    /// degraded read it really pauses `health_monitor`, a real
    /// cross-contract call, not a status callers have to notice and act
    /// on themselves. Self-authorizing: this contract's own address is
    /// the `guardian` argument, valid only because this contract is
    /// really the caller in that frame, the same pattern `timelock` uses
    /// to call `risk-engine`. Uses `try_pause` deliberately: a vault that
    /// hasn't registered OracleRouter as a guardian on its own
    /// `health_monitor` must still get a correct degraded/not-degraded
    /// answer back, not a reverted call. See adr/0010.
    pub fn check_and_trip(e: Env, asset: Asset, health_monitor: Address) -> bool {
        let q = Self::get_price(e.clone(), asset);
        let degraded = matches!(q.status, OracleStatus::Degraded | OracleStatus::HardStop);
        if degraded {
            let _ = HealthMonitorClient::new(&e, &health_monitor)
                .try_pause(&e.current_contract_address());
        }
        degraded
    }
}

struct FeedRead {
    price_router_decimals: i128,
    timestamp: u64,
}

/// try_X client calls return a doubly-wrapped Result: the outer layer is a
/// host-invocation error (contract missing, trapped, etc.), the inner
/// layer is an XDR-conversion error. Both collapse to "couldn't get a
/// value" for our purposes — a down or misbehaving feed removes itself
/// from quorum rather than panicking the whole read.
fn fetch_lastprice(client: &PriceFeedClient, asset: &Asset) -> Option<Sep40PriceData> {
    client.try_lastprice(asset).ok()?.ok()?
}

fn fetch_decimals(client: &PriceFeedClient) -> Option<u32> {
    client.try_decimals().ok()?.ok()
}

fn fetch_prices(
    client: &PriceFeedClient,
    asset: &Asset,
    periods: u32,
) -> Option<soroban_sdk::Vec<Sep40PriceData>> {
    client.try_prices(asset, &periods).ok()?.ok()?
}

/// Fetches lastprice + decimals from a feed and rescales to ROUTER_DECIMALS.
/// decimals() is read fresh on every call, never cached: RedStone's own
/// contract documents decimals() as mutable, a deviation from the SEP-40
/// standard it otherwise implements. Staleness is checked here, before any
/// divergence math runs, so a stale feed removes itself from quorum instead
/// of contributing to a false divergence trip.
fn fetch_fresh(
    e: &Env,
    feed: &Address,
    asset: &Asset,
    max_staleness: u64,
    now: u64,
) -> Option<FeedRead> {
    let client = PriceFeedClient::new(e, feed);
    let pd = fetch_lastprice(&client, asset)?;
    if now.saturating_sub(pd.timestamp) > max_staleness {
        return None;
    }
    let decimals = fetch_decimals(&client)?;
    Some(FeedRead {
        price_router_decimals: rescale(pd.price, decimals, ROUTER_DECIMALS),
        timestamp: pd.timestamp,
    })
}

pub fn rescale(price: i128, from_decimals: u32, to_decimals: u32) -> i128 {
    if from_decimals == to_decimals {
        return price;
    }
    if from_decimals < to_decimals {
        price.saturating_mul(10i128.saturating_pow(to_decimals - from_decimals))
    } else {
        price / 10i128.saturating_pow(from_decimals - to_decimals)
    }
}

/// Divergence in bps: |p - s| / min(p, s) * 10000.
pub fn divergence_bps(p: i128, s: i128) -> u32 {
    if p <= 0 || s <= 0 {
        return u32::MAX;
    }
    let diff = (p - s).unsigned_abs();
    let denom = p.min(s) as u128;
    ((diff.saturating_mul(BPS_DENOM as u128)) / denom).min(u32::MAX as u128) as u32
}

fn twap(e: &Env, feed: &Address, asset: &Asset, periods: u32) -> Option<i128> {
    let client = PriceFeedClient::new(e, feed);
    let records = fetch_prices(&client, asset, periods)?;
    if records.is_empty() {
        return None;
    }
    let decimals = fetch_decimals(&client)?;
    let mut sum: i128 = 0;
    let mut count: i128 = 0;
    for pd in records.iter() {
        sum = sum.saturating_add(rescale(pd.price, decimals, ROUTER_DECIMALS));
        count += 1;
    }
    if count == 0 {
        None
    } else {
        Some(sum / count)
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_both_available(
    e: &Env,
    cfg: &AssetOracleConfig,
    asset: &Asset,
    p: FeedRead,
    s: FeedRead,
    now: u64,
    last_accepted: Option<&PriceQuote>,
) -> PriceQuote {
    let d = divergence_bps(p.price_router_decimals, s.price_router_decimals);

    if d <= cfg.divergence_soft {
        // Dual-confirmed by construction: both independent feeds agree
        // within the soft band, so the ROC clamp is exempted here — this
        // is the specific case the clamp is designed to let through.
        let low = p.price_router_decimals.min(s.price_router_decimals);
        let high = p.price_router_decimals.max(s.price_router_decimals);
        return PriceQuote {
            price: low,
            timestamp: now,
            status: OracleStatus::Healthy,
            conservative_low: low,
            conservative_high: high,
        };
    }

    if d <= cfg.divergence_hard {
        let Some(t) = twap(e, &cfg.primary_feed, &cfg.primary_asset, cfg.twap_periods) else {
            return degraded_quote(e, asset, last_accepted, now);
        };
        let cross_check = divergence_bps(t, s.price_router_decimals);
        if cross_check > cfg.divergence_hard {
            return degraded_quote(e, asset, last_accepted, now);
        }
        if !roc_ok(cfg.max_roc_per_update, t, last_accepted) {
            PxRocReject {
                asset: asset.clone(),
                old: last_accepted.map(|q| q.price).unwrap_or(0),
                new: t,
            }
            .publish(e);
            return degraded_quote(e, asset, last_accepted, now);
        }
        PxWarn {
            asset: asset.clone(),
            primary: p.price_router_decimals,
            secondary: s.price_router_decimals,
            divergence_bps: d,
        }
        .publish(e);
        return PriceQuote {
            price: t,
            timestamp: now,
            status: OracleStatus::Healthy,
            conservative_low: t,
            conservative_high: t,
        };
    }

    degraded_quote(e, asset, last_accepted, now)
}

fn resolve_one_available(
    e: &Env,
    cfg: &AssetOracleConfig,
    asset: &Asset,
    f: FeedRead,
    now: u64,
    last_accepted: Option<&PriceQuote>,
) -> PriceQuote {
    // No second feed to corroborate: the ROC clamp is never exempted here.
    // A single-feed manipulated tick must always fail this check.
    if !roc_ok(
        cfg.max_roc_per_update,
        f.price_router_decimals,
        last_accepted,
    ) {
        PxRocReject {
            asset: asset.clone(),
            old: last_accepted.map(|q| q.price).unwrap_or(0),
            new: f.price_router_decimals,
        }
        .publish(e);
        return degraded_quote(e, asset, last_accepted, now);
    }

    let key = DataKey::OneFeedSince(asset.clone());
    let since: u64 = e.storage().persistent().get(&key).unwrap_or(now);
    if !e.storage().persistent().has(&key) {
        e.storage().persistent().set(&key, &since);
    }

    if now.saturating_sub(since) > ONE_FEED_DEGRADE_AFTER {
        return degraded_quote(e, asset, last_accepted, now);
    }

    PriceQuote {
        price: f.price_router_decimals,
        timestamp: f.timestamp,
        status: OracleStatus::OneFeed,
        conservative_low: f.price_router_decimals,
        conservative_high: f.price_router_decimals,
    }
}

/// Takes the bound directly instead of the whole `AssetOracleConfig`:
/// this is the only field of it the check ever reads, and narrowing the
/// signature makes the function callable (and fuzzable) without needing
/// an `Env` to build a config just to reach one `u32`.
pub fn roc_ok(
    max_roc_per_update: u32,
    candidate: i128,
    last_accepted: Option<&PriceQuote>,
) -> bool {
    let Some(last) = last_accepted else {
        // Nothing accepted yet: no baseline to clamp against, first write
        // through always passes.
        return true;
    };
    if last.price == 0 {
        return true;
    }
    let roc = divergence_bps(candidate, last.price);
    roc <= max_roc_per_update
}

fn degraded_quote(
    e: &Env,
    asset: &Asset,
    last_accepted: Option<&PriceQuote>,
    now: u64,
) -> PriceQuote {
    PxDegraded {
        asset: asset.clone(),
    }
    .publish(e);
    PriceQuote {
        price: last_accepted.map(|q| q.price).unwrap_or(0),
        timestamp: now,
        status: OracleStatus::Degraded,
        conservative_low: last_accepted.map(|q| q.conservative_low).unwrap_or(0),
        conservative_high: last_accepted.map(|q| q.conservative_high).unwrap_or(0),
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use proptest::prelude::*;
    use sep_40_oracle::PriceFeedTrait;
    use soroban_sdk::{
        contract, contractimpl, contracttype,
        testutils::{Address as _, Ledger},
        vec, Symbol, Vec,
    };

    #[contracttype]
    enum MockKey {
        History(Asset),
        Decimals,
    }

    #[contract]
    struct MockFeed;

    #[contractimpl]
    impl MockFeed {
        /// Test setup only. History is stored oldest-first; lastprice()
        /// returns the final entry, prices(n) returns the last n.
        pub fn push_price(e: Env, asset: Asset, price: i128, timestamp: u64) {
            let key = MockKey::History(asset);
            let mut hist: Vec<Sep40PriceData> =
                e.storage().persistent().get(&key).unwrap_or(vec![&e]);
            hist.push_back(Sep40PriceData { price, timestamp });
            e.storage().persistent().set(&key, &hist);
        }

        pub fn set_decimals(e: Env, decimals: u32) {
            e.storage().instance().set(&MockKey::Decimals, &decimals);
        }
    }

    #[contractimpl]
    impl PriceFeedTrait for MockFeed {
        fn base(e: Env) -> Asset {
            Asset::Other(Symbol::new(&e, "USD"))
        }

        fn assets(_e: Env) -> Vec<Asset> {
            panic!("not needed for tests")
        }

        fn decimals(e: Env) -> u32 {
            e.storage().instance().get(&MockKey::Decimals).unwrap_or(14)
        }

        fn resolution(_e: Env) -> u32 {
            300
        }

        fn price(_e: Env, _asset: Asset, _timestamp: u64) -> Option<Sep40PriceData> {
            panic!("not needed for tests")
        }

        fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<Sep40PriceData>> {
            let hist: Vec<Sep40PriceData> =
                e.storage().persistent().get(&MockKey::History(asset))?;
            let len = hist.len();
            let take = records.min(len);
            if take == 0 {
                return None;
            }
            let mut out = vec![&e];
            for i in (len - take)..len {
                out.push_back(hist.get_unchecked(i));
            }
            Some(out)
        }

        fn lastprice(e: Env, asset: Asset) -> Option<Sep40PriceData> {
            let hist: Vec<Sep40PriceData> =
                e.storage().persistent().get(&MockKey::History(asset))?;
            if hist.is_empty() {
                None
            } else {
                Some(hist.get_unchecked(hist.len() - 1))
            }
        }
    }

    /// Real, compiled, deployed-in-test contract implementing the exact
    /// `HealthMonitorInterface` `check_and_trip` cross-calls, mirroring
    /// the real `health-monitor`'s guardian-gated `pause()`: proves the
    /// real cross-contract invocation and self-authorization mechanics,
    /// not an assumption about them.
    #[contracttype]
    enum MockHmKey {
        Guardians,
        PauseCount,
    }

    #[contract]
    struct MockHealthMonitor;

    #[contractimpl]
    impl MockHealthMonitor {
        pub fn set_guardians(e: Env, guardians: Vec<Address>) {
            e.storage()
                .instance()
                .set(&MockHmKey::Guardians, &guardians);
        }

        pub fn pause_count(e: Env) -> u32 {
            e.storage()
                .instance()
                .get(&MockHmKey::PauseCount)
                .unwrap_or(0)
        }
    }

    #[allow(dead_code)]
    #[contractclient(name = "MockHealthMonitorTestClient")]
    trait MockHmSetup {
        fn set_guardians(e: Env, guardians: Vec<Address>);
        fn pause_count(e: Env) -> u32;
    }

    #[contractimpl]
    impl HealthMonitorInterface for MockHealthMonitor {
        fn pause(e: Env, guardian: Address) {
            guardian.require_auth();
            let guardians: Vec<Address> = e
                .storage()
                .instance()
                .get(&MockHmKey::Guardians)
                .unwrap_or(vec![&e]);
            if !guardians.contains(&guardian) {
                panic!("guardian not registered");
            }
            let count: u32 = e
                .storage()
                .instance()
                .get(&MockHmKey::PauseCount)
                .unwrap_or(0);
            e.storage()
                .instance()
                .set(&MockHmKey::PauseCount, &(count + 1));
        }
    }

    fn advance_to_realistic_ledger(e: &Env) {
        e.ledger().with_mut(|l| {
            l.timestamp = 2_000_000_000;
            l.sequence_number = 2_000_000;
        });
    }

    fn setup(e: &Env) -> (OracleRouterClient<'_>, Address, Address, Asset) {
        advance_to_realistic_ledger(e);
        let router_id = e.register(OracleRouter, ());
        let router = OracleRouterClient::new(e, &router_id);
        let primary_id = e.register(MockFeed, ());
        let secondary_id = e.register(MockFeed, ());
        let asset = Asset::Other(Symbol::new(e, "XLM"));
        (router, primary_id, secondary_id, asset)
    }

    fn default_cfg(primary: &Address, secondary: &Address) -> AssetOracleConfig {
        // Same asset key on both feeds by default — tests that specifically
        // exercise per-feed asset-key mismatch build their own config.
        let e = Env::default();
        let asset = Asset::Other(Symbol::new(&e, "XLM"));
        AssetOracleConfig {
            primary_feed: primary.clone(),
            primary_asset: asset.clone(),
            secondary_feed: secondary.clone(),
            secondary_asset: asset,
            max_staleness_primary: 600,
            max_staleness_secondary: 600,
            twap_periods: 6,
            divergence_soft: 200,     // 2%
            divergence_hard: 500,     // 5%
            max_roc_per_update: 1000, // 10%
        }
    }

    fn push(e: &Env, feed_id: &Address, asset: &Asset, price: i128, ts: u64) {
        let client = MockFeedClient::new(e, feed_id);
        client.push_price(asset, &price, &ts);
    }

    // ################## CONFIG VALIDATION ##################

    #[test]
    fn set_config_rejects_zero_twap_periods() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        let mut cfg = default_cfg(&primary, &secondary);
        cfg.twap_periods = 0;
        let result = router.try_set_config(&asset, &cfg);
        assert!(result.is_err());
    }

    #[test]
    fn set_config_rejects_twap_periods_over_history_cap_margin() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        let mut cfg = default_cfg(&primary, &secondary);
        cfg.twap_periods = 65;
        let result = router.try_set_config(&asset, &cfg);
        assert!(result.is_err());
    }

    #[test]
    fn set_config_rejects_soft_gte_hard() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        let mut cfg = default_cfg(&primary, &secondary);
        cfg.divergence_soft = 500;
        cfg.divergence_hard = 500;
        let result = router.try_set_config(&asset, &cfg);
        assert!(result.is_err());
    }

    #[test]
    fn set_config_rejects_zero_staleness() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        let mut cfg = default_cfg(&primary, &secondary);
        cfg.max_staleness_primary = 0;
        let result = router.try_set_config(&asset, &cfg);
        assert!(result.is_err());
    }

    // ################## CORE READ ALGORITHM ##################

    #[test]
    fn both_feeds_agree_within_soft_returns_healthy() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_50000000, now);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Healthy);
        assert_eq!(q.price, 100_00000000);
        assert_eq!(q.conservative_low, 100_00000000);
        assert_eq!(q.conservative_high, 100_50000000);
    }

    #[test]
    fn divergence_beyond_hard_returns_degraded() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        // First establish a healthy baseline so last_accepted exists.
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);
        router.get_price(&asset);

        // A single feed spikes 100x — the exact YieldBlox failure shape.
        e.ledger().with_mut(|l| l.timestamp += 300);
        let now2 = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now2);
        push(&e, &secondary, &asset, 1_000_000_000_000, now2);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Degraded);
        // Degraded must return the last accepted price, not the spike.
        assert_eq!(q.price, 100_00000000);
    }

    #[test]
    fn stale_primary_falls_back_to_secondary_as_one_feed() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        // Primary is old (beyond max_staleness_primary=600).
        push(&e, &primary, &asset, 100_00000000, now.saturating_sub(9999));
        push(&e, &secondary, &asset, 100_00000000, now);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::OneFeed);
        assert_eq!(q.price, 100_00000000);
    }

    #[test]
    fn one_feed_escalates_to_degraded_after_thirty_minutes() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &secondary, &asset, 100_00000000, now);
        // Primary never populated: always unavailable this test.
        let q1 = router.get_price(&asset);
        assert_eq!(q1.status, OracleStatus::OneFeed);

        e.ledger().with_mut(|l| l.timestamp += 1801);
        let now2 = e.ledger().timestamp();
        push(&e, &secondary, &asset, 100_00000000, now2);
        let q2 = router.get_price(&asset);
        assert_eq!(q2.status, OracleStatus::Degraded);
    }

    #[test]
    fn neither_feed_available_returns_hardstop() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::HardStop);
    }

    #[test]
    fn roc_clamp_rejects_single_feed_manipulated_tick() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);
        let baseline = router.get_price(&asset);
        assert_eq!(baseline.status, OracleStatus::Healthy);

        // Advance past max_staleness_secondary (600s) so secondary's last
        // push genuinely falls out of quorum, isolating the one-feed path
        // from the already-covered "both available, beyond hard" case.
        // Primary alone then spikes 100x: no second feed to corroborate,
        // so ROC must reject this outright.
        e.ledger().with_mut(|l| l.timestamp += 700);
        let now2 = e.ledger().timestamp();
        push(&e, &primary, &asset, 1_000_000_000_000, now2);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Degraded);
        assert_eq!(
            q.price, baseline.price,
            "must hold the last accepted price, never the spike"
        );
    }

    #[test]
    fn roc_clamp_exempted_when_both_feeds_confirm_the_move() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);
        router.get_price(&asset);

        // A real 50% move, but both feeds move together within the soft
        // band: dual-confirmed, so it must be accepted despite exceeding
        // max_roc_per_update (10%).
        e.ledger().with_mut(|l| l.timestamp += 300);
        let now2 = e.ledger().timestamp();
        push(&e, &primary, &asset, 150_00000000, now2);
        push(&e, &secondary, &asset, 150_20000000, now2);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Healthy);
        assert_eq!(q.price, 150_00000000);
    }

    #[test]
    fn decimals_rescaled_correctly_across_mismatched_feeds() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        // Primary at router-native 14 decimals, secondary at RedStone's 8.
        let primary_client = MockFeedClient::new(&e, &primary);
        primary_client.set_decimals(&14);
        let secondary_client = MockFeedClient::new(&e, &secondary);
        secondary_client.set_decimals(&8);

        let now = e.ledger().timestamp();
        // $1.00 at 14 decimals vs $1.00 at 8 decimals.
        push(&e, &primary, &asset, 1_00000000000000, now);
        push(&e, &secondary, &asset, 1_00000000, now);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Healthy);
        assert_eq!(
            q.price, 1_00000000000000,
            "both sides must agree once rescaled to 14 decimals"
        );
    }

    #[test]
    fn per_feed_asset_keys_can_differ_for_the_same_logical_asset() {
        // Mirrors a real finding from testnet: Reflector keys XLM as
        // Other(Symbol("XLM")) while RedStone keys the same asset as
        // Stellar(<SAC address>). The router's own logical asset key
        // (used for config/storage/events) is independent of what gets
        // sent to each feed.
        let e = Env::default();
        let (router, primary, secondary, _) = setup(&e);
        let logical_asset = Asset::Other(Symbol::new(&e, "XLM"));
        let primary_asset = Asset::Other(Symbol::new(&e, "XLM"));
        let sac = Address::generate(&e);
        let secondary_asset = Asset::Stellar(sac);

        let mut cfg = default_cfg(&primary, &secondary);
        cfg.primary_asset = primary_asset.clone();
        cfg.secondary_asset = secondary_asset.clone();
        router.set_config(&logical_asset, &cfg);

        let now = e.ledger().timestamp();
        push(&e, &primary, &primary_asset, 100_00000000, now);
        push(&e, &secondary, &secondary_asset, 100_10000000, now);

        let q = router.get_price(&logical_asset);
        assert_eq!(q.status, OracleStatus::Healthy);
        assert_eq!(q.price, 100_00000000);
    }

    #[test]
    fn twap_branch_used_in_hard_divergence_band() {
        let e = Env::default();
        let (router, primary, secondary, asset) = setup(&e);
        let mut cfg = default_cfg(&primary, &secondary);
        cfg.twap_periods = 3;
        router.set_config(&asset, &cfg);

        let now = e.ledger().timestamp();
        // Primary history averages to 103; secondary sits at 100, giving
        // ~3% divergence against the raw primary lastprice — inside the
        // hard band (5%) but outside soft (2%), landing in the TWAP branch.
        push(&e, &primary, &asset, 102_00000000, now.saturating_sub(600));
        push(&e, &primary, &asset, 103_00000000, now.saturating_sub(300));
        push(&e, &primary, &asset, 104_00000000, now);
        push(&e, &secondary, &asset, 100_00000000, now);

        let q = router.get_price(&asset);
        assert_eq!(q.status, OracleStatus::Healthy);
        assert_eq!(q.price, 103_00000000, "TWAP of the 3 primary records");
    }

    // ################## CHECK_AND_TRIP (real HealthMonitor pause) ##################

    #[test]
    fn check_and_trip_pauses_real_health_monitor_when_degraded() {
        let e = Env::default();
        e.mock_all_auths();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);
        router.get_price(&asset);

        e.ledger().with_mut(|l| l.timestamp += 300);
        let now2 = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now2);
        push(&e, &secondary, &asset, 1_000_000_000_000, now2);

        let hm_id = e.register(MockHealthMonitor, ());
        let hm_setup = MockHealthMonitorTestClient::new(&e, &hm_id);
        hm_setup.set_guardians(&Vec::from_array(&e, [router.address.clone()]));

        let tripped = router.check_and_trip(&asset, &hm_id);
        assert!(tripped, "a genuinely degraded read must report tripped");
        assert_eq!(
            hm_setup.pause_count(),
            1,
            "check_and_trip must actually call the real HealthMonitor's pause(), not just report a status"
        );
    }

    #[test]
    fn check_and_trip_does_not_pause_when_healthy() {
        let e = Env::default();
        e.mock_all_auths();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);

        let hm_id = e.register(MockHealthMonitor, ());
        let hm_setup = MockHealthMonitorTestClient::new(&e, &hm_id);
        hm_setup.set_guardians(&Vec::from_array(&e, [router.address.clone()]));

        let tripped = router.check_and_trip(&asset, &hm_id);
        assert!(!tripped);
        assert_eq!(
            hm_setup.pause_count(),
            0,
            "a healthy read must never touch HealthMonitor at all"
        );
    }

    #[test]
    fn check_and_trip_still_reports_tripped_even_if_guardian_unregistered() {
        let e = Env::default();
        e.mock_all_auths();
        let (router, primary, secondary, asset) = setup(&e);
        router.set_config(&asset, &default_cfg(&primary, &secondary));

        let now = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now);
        push(&e, &secondary, &asset, 100_10000000, now);
        router.get_price(&asset);

        e.ledger().with_mut(|l| l.timestamp += 300);
        let now2 = e.ledger().timestamp();
        push(&e, &primary, &asset, 100_00000000, now2);
        push(&e, &secondary, &asset, 1_000_000_000_000, now2);

        let hm_id = e.register(MockHealthMonitor, ());
        let hm_setup = MockHealthMonitorTestClient::new(&e, &hm_id);
        // Deliberately never registers the router as a guardian: a vault
        // that hasn't opted into the automated guardian must still get a
        // correct answer back, not a reverted call.
        hm_setup.set_guardians(&Vec::new(&e));

        let tripped = router.check_and_trip(&asset, &hm_id);
        assert!(
            tripped,
            "an unregistered guardian must not turn a real degraded read into a failed call"
        );
    }

    // ################## PROPERTY TESTS ##################

    proptest! {
        #[test]
        fn prop_roc_clamp_never_lets_unconfirmed_jump_through(
            baseline in 50_00000000i128..=200_00000000,
            jump_bps in 1100u32..=50_000, // always > max_roc_per_update (1000)
        ) {
            let e = Env::default();
            let (router, primary, secondary, asset) = setup(&e);
            router.set_config(&asset, &default_cfg(&primary, &secondary));

            let now = e.ledger().timestamp();
            push(&e, &primary, &asset, baseline, now);
            push(&e, &secondary, &asset, baseline, now);
            let baseline_quote = router.get_price(&asset);
            prop_assume!(baseline_quote.status == OracleStatus::Healthy);

            // Past max_staleness_secondary (600s): secondary's last push
            // genuinely falls out of quorum rather than merely reporting
            // an unchanged price, isolating the one-feed ROC path.
            e.ledger().with_mut(|l| l.timestamp += 700);
            let now2 = e.ledger().timestamp();
            let jumped = baseline + (baseline * jump_bps as i128 / BPS_DENOM);
            // Only primary jumps; secondary is not repushed and is now
            // stale, so there is no second feed to corroborate the move.
            push(&e, &primary, &asset, jumped, now2);

            let q = router.get_price(&asset);
            prop_assert_eq!(q.price, baseline_quote.price);
            prop_assert!(matches!(q.status, OracleStatus::Degraded));
        }
    }
}
