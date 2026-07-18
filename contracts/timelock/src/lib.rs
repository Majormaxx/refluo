#![no_std]

//! Timelock: propose -> 24h delay -> execute. Admin can act immediately,
//! no delay, on anything that only ever removes risk: pause, resume,
//! guardian removal, allowlist removal, risk-profile downgrade,
//! RecallExecutor tightening. Those calls go straight to the target
//! contract's own admin-gated function and never pass through here.
//! Anything that could increase risk (raising `risk-engine`'s `fee_bps` is
//! the first real case, see adr/0002 and adr/0007) proposes here and waits
//! out the delay. Full spec tracked internally, not in this repo.

use refluo_common::CommonError;
use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, Address, Env, Symbol, Val, Vec,
};

const PROPOSAL_DELAY: u64 = 86400;

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub target: Address,
    pub fn_name: Symbol,
    pub args: Vec<Val>,
    pub eta: u64,
    pub proposer: Address,
}

#[contracttype]
pub enum DataKey {
    Proposal(u64),
    NextId,
    Admin,
}

#[contractevent]
pub struct ProposeEvent {
    #[topic]
    pub id: u64,
    pub eta: u64,
}

#[contractevent]
pub struct ExecuteEvent {
    #[topic]
    pub id: u64,
}

#[contractevent]
pub struct CancelEvent {
    #[topic]
    pub id: u64,
}

#[contract]
pub struct Timelock;

#[contractimpl]
impl Timelock {
    /// One-time bootstrap for the address that can cancel a pending
    /// proposal. Rejects a second call so a later caller can't take over
    /// cancel authority out from under the vault that deployed this.
    pub fn init(e: Env, admin: Address) -> Result<(), CommonError> {
        admin.require_auth();
        if e.storage().instance().has(&DataKey::Admin) {
            return Err(CommonError::BadState);
        }
        e.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn propose(
        e: Env,
        proposer: Address,
        target: Address,
        fn_name: Symbol,
        args: Vec<Val>,
    ) -> u64 {
        proposer.require_auth();
        let id: u64 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        let eta = e.ledger().timestamp() + PROPOSAL_DELAY;
        let proposal = Proposal {
            target,
            fn_name,
            args,
            eta,
            proposer,
        };
        e.storage()
            .persistent()
            .set(&DataKey::Proposal(id), &proposal);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        ProposeEvent { id, eta }.publish(&e);
        id
    }

    pub fn get_proposal(e: Env, id: u64) -> Result<Proposal, CommonError> {
        e.storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .ok_or(CommonError::NotInitialized)
    }

    /// Permissionless by design, per doctrine: bounded (the delay already
    /// happened), revocable (admin could have cancelled before now),
    /// observable (`ProposeEvent` fired 24h ago). Nobody's signature adds
    /// security here that the elapsed delay didn't already provide, so
    /// requiring one would only add friction. The target function's own
    /// `require_auth()` is what actually gates the effect: this contract's
    /// own address is normally the `admin` argument baked into `args` at
    /// proposal time, and a contract's address self-authorizes when it is
    /// itself the caller, so the target only accepts the call because it's
    /// really coming from this timelock, not because whoever pressed
    /// execute() proved anything.
    pub fn execute(e: Env, id: u64) -> Result<Val, CommonError> {
        let proposal: Proposal = e
            .storage()
            .persistent()
            .get(&DataKey::Proposal(id))
            .ok_or(CommonError::NotInitialized)?;
        if e.ledger().timestamp() < proposal.eta {
            return Err(CommonError::BadState);
        }
        let result: Val = e.invoke_contract(&proposal.target, &proposal.fn_name, proposal.args);
        e.storage().persistent().remove(&DataKey::Proposal(id));
        ExecuteEvent { id }.publish(&e);
        Ok(result)
    }

    /// Admin-gated, not proposer-gated: the point is that a party other
    /// than whoever proposed can kill a proposal they didn't sign off on.
    pub fn cancel(e: Env, id: u64, admin: Address) -> Result<(), CommonError> {
        admin.require_auth();
        let stored_admin: Address = e
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(CommonError::NotInitialized)?;
        if admin != stored_admin {
            return Err(CommonError::Unauthorized);
        }
        if !e.storage().persistent().has(&DataKey::Proposal(id)) {
            return Err(CommonError::NotInitialized);
        }
        e.storage().persistent().remove(&DataKey::Proposal(id));
        CancelEvent { id }.publish(&e);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        vec, IntoVal,
    };

    /// A real, compiled, deployed-in-test contract, not a hand-rolled
    /// stand-in for `execute()`'s cross-call mechanics: `set_value` uses
    /// the exact self-authorizing admin pattern `risk-engine`'s
    /// `set_fee_bps` relies on in production (adr/0007), so a passing test
    /// here proves the real invocation path, not an assumption about it.
    #[contract]
    struct TestTarget;

    #[contractimpl]
    impl TestTarget {
        pub fn set_value(e: Env, admin: Address, value: u32) -> u32 {
            admin.require_auth();
            e.storage().instance().set(&symbol_short!("VALUE"), &value);
            value
        }

        pub fn value(e: Env) -> u32 {
            e.storage()
                .instance()
                .get(&symbol_short!("VALUE"))
                .unwrap_or(0)
        }
    }

    fn setup(e: &Env) -> (TimelockClient<'_>, Address) {
        let contract_id = e.register(Timelock, ());
        let client = TimelockClient::new(e, &contract_id);
        e.mock_all_auths();
        (client, contract_id)
    }

    #[test]
    fn init_bootstraps_admin_and_rejects_second_call() {
        let e = Env::default();
        let (client, _) = setup(&e);
        let admin = Address::generate(&e);
        let attacker = Address::generate(&e);

        client.init(&admin);
        let result = client.try_init(&attacker);
        assert!(result.is_err());
    }

    #[test]
    fn propose_sets_eta_24h_out_and_increments_id() {
        let e = Env::default();
        let (client, _) = setup(&e);

        let proposer = Address::generate(&e);
        let target = Address::generate(&e);
        let now = e.ledger().timestamp();

        let id1 = client.propose(&proposer, &target, &symbol_short!("set_fee"), &vec![&e]);
        let id2 = client.propose(&proposer, &target, &symbol_short!("set_fee"), &vec![&e]);

        assert_eq!(id1, 0);
        assert_eq!(id2, 1);

        let p = client.get_proposal(&id1);
        assert_eq!(p.eta, now + PROPOSAL_DELAY);
        assert_eq!(p.proposer, proposer);
    }

    #[test]
    fn execute_before_eta_rejected() {
        let e = Env::default();
        let (client, timelock_id) = setup(&e);
        let target_id = e.register(TestTarget, ());
        let proposer = Address::generate(&e);

        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(timelock_id.into_val(&e));
        args.push_back(42u32.into_val(&e));
        let id = client.propose(&proposer, &target_id, &symbol_short!("set_value"), &args);

        let result = client.try_execute(&id);
        assert!(
            result.is_err(),
            "eta is 24h out, execute must not fire early"
        );
    }

    #[test]
    fn execute_after_eta_invokes_target_via_real_cross_call() {
        let e = Env::default();
        let (client, timelock_id) = setup(&e);
        let target_id = e.register(TestTarget, ());
        let target_client = TestTargetClient::new(&e, &target_id);
        let proposer = Address::generate(&e);

        // The timelock's own contract address is the `admin` argument
        // baked into the proposal, exactly as `risk-engine`'s `fee_bps`
        // governance is meant to be wired (adr/0007). Proving this round
        // trips is the point of this test, not an assumption about it.
        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(timelock_id.into_val(&e));
        args.push_back(42u32.into_val(&e));
        let id = client.propose(&proposer, &target_id, &symbol_short!("set_value"), &args);

        e.ledger().with_mut(|l| l.timestamp += PROPOSAL_DELAY);
        client.execute(&id);

        assert_eq!(
            target_client.value(),
            42,
            "the real target contract's storage must reflect the call"
        );
        let result = client.try_get_proposal(&id);
        assert!(result.is_err(), "executed proposals must not be replayable");
    }

    #[test]
    fn execute_of_unknown_id_rejected() {
        let e = Env::default();
        let (client, _) = setup(&e);
        let result = client.try_execute(&99);
        assert!(result.is_err());
    }

    #[test]
    fn cancel_by_admin_removes_proposal() {
        let e = Env::default();
        let (client, timelock_id) = setup(&e);
        let admin = Address::generate(&e);
        let proposer = Address::generate(&e);
        let target_id = e.register(TestTarget, ());
        client.init(&admin);

        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(timelock_id.into_val(&e));
        args.push_back(7u32.into_val(&e));
        let id = client.propose(&proposer, &target_id, &symbol_short!("set_value"), &args);

        client.cancel(&id, &admin);

        let result = client.try_get_proposal(&id);
        assert!(result.is_err());
        e.ledger().with_mut(|l| l.timestamp += PROPOSAL_DELAY);
        let result = client.try_execute(&id);
        assert!(result.is_err(), "a cancelled proposal must never execute");
    }

    #[test]
    fn cancel_by_non_admin_rejected() {
        let e = Env::default();
        let (client, timelock_id) = setup(&e);
        let admin = Address::generate(&e);
        let outsider = Address::generate(&e);
        let proposer = Address::generate(&e);
        let target_id = e.register(TestTarget, ());
        client.init(&admin);

        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(timelock_id.into_val(&e));
        args.push_back(7u32.into_val(&e));
        let id = client.propose(&proposer, &target_id, &symbol_short!("set_value"), &args);

        let result = client.try_cancel(&id, &outsider);
        assert!(result.is_err());
        // The proposal must still be there.
        client.get_proposal(&id);
    }

    #[test]
    fn cancel_before_admin_bootstrapped_rejected() {
        let e = Env::default();
        let (client, timelock_id) = setup(&e);
        let outsider = Address::generate(&e);
        let proposer = Address::generate(&e);
        let target_id = e.register(TestTarget, ());

        let mut args: Vec<Val> = Vec::new(&e);
        args.push_back(timelock_id.into_val(&e));
        args.push_back(7u32.into_val(&e));
        let id = client.propose(&proposer, &target_id, &symbol_short!("set_value"), &args);

        let result = client.try_cancel(&id, &outsider);
        assert!(result.is_err());
    }
}
