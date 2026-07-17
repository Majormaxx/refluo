#![no_std]

//! Timelock — <200 lines. propose -> 24h delay -> execute. Exempt list
//! (direct admin, no delay): pause, resume, guardian removal, allowlist
//! removal, risk-profile downgrade, RecallExecutor tightening — the rule
//! is: risk-reducing actions are exempt, risk-increasing actions wait.
//! Full spec: refluo-implementation-spec.md §7 (local, not in this repo).

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
}

#[contractevent]
pub struct ProposeEvent {
    #[topic]
    pub id: u64,
    pub eta: u64,
}

#[contract]
pub struct Timelock;

#[contractimpl]
impl Timelock {
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

    // execute / cancel: Phase 4. execute is permissionless-after-eta by
    // design (anyone can trigger, per roadmap doctrine: bounded, revocable,
    // observable); invokes target.fn_name(args) via cross-contract call.
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{symbol_short, testutils::Address as _, vec};

    #[test]
    fn propose_sets_eta_24h_out_and_increments_id() {
        let e = Env::default();
        let contract_id = e.register(Timelock, ());
        let client = TimelockClient::new(&e, &contract_id);

        let proposer = Address::generate(&e);
        let target = Address::generate(&e);
        let now = e.ledger().timestamp();

        e.mock_all_auths();
        let id1 = client.propose(&proposer, &target, &symbol_short!("set_fee"), &vec![&e]);
        let id2 = client.propose(&proposer, &target, &symbol_short!("set_fee"), &vec![&e]);

        assert_eq!(id1, 0);
        assert_eq!(id2, 1);

        let p = client.get_proposal(&id1);
        assert_eq!(p.eta, now + PROPOSAL_DELAY);
        assert_eq!(p.proposer, proposer);
    }
}
