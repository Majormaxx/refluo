# ADR 0007: Timelock execute/cancel, and how a contract becomes another contract's admin

Status: accepted. Date: 2026-07.

## Decision

`contracts/timelock` now implements `execute()` and `cancel()`, closing the
gap left when the contract shipped with only `propose()`. `execute()` is
permissionless once a proposal's 24h `eta` has passed: no caller signature
adds security that the elapsed delay and the still-open cancel window
didn't already provide. `cancel()` is gated to a stored admin address,
bootstrapped once via `init()`, so a party other than the proposer can
kill a proposal before it fires.

`risk-engine`'s `set_fee_bps` now checks a real stored admin instead of
trusting whatever address a caller signs as its own, closing the gap
`adr/0002` flagged from the start. Two new functions carry that:
`init_admin()` bootstraps the first admin, and `transfer_admin()` hands
governance to a new address with only the current admin's signature, the
new address never signs for itself.

## Why

Live testnet deployment surfaced a fact about Soroban's authorization
model that no amount of local unit testing would have forced into the
open: `some_address.require_auth()` only ever succeeds when `some_address`
is a real signing key present in the transaction, or when `some_address`
is the contract that is *itself* the direct caller of that invocation
frame. There is no third way for a contract address to consent to
something a plain account transaction proposes on its behalf. Concretely:
calling `risk_engine.init_admin(timelock_contract_address)` from the
deploying EOA's own transaction can never succeed, because the EOA's
transaction is the caller, not the timelock contract, no matter whose
address is passed as the argument. This only became visible by actually
trying it against a live deployment; a mocked or hand-simulated auth
check would have happily accepted whatever address was passed in.

`transfer_admin()` is the standard fix, the same one `Ownable.transferOwnership`
uses: only the *current* admin's signature is required to name a
successor, because the current admin choosing who comes next is already
the entire trust boundary, and requiring the successor's own signature is
impossible for a contract address anyway, not merely inconvenient. Once
`risk-engine`'s admin is `timelock`'s own contract address, raising the
fee genuinely requires a proposal that survived the 24h delay: `timelock`'s
`execute()` calls `set_fee_bps` with its own address baked into the
proposal's args, and that call self-authorizes because `timelock` really
is the direct caller in that frame. Nobody can shortcut this by signing as
"admin" the way the original scaffold allowed.

## Consequences

- Every contract that wants its risk-increasing actions gated by
  `timelock` needs the same two-function pattern: a bootstrap that accepts
  any first admin, and a transfer function gated by the current admin
  alone. A single-shot "set admin to this contract address" call is not
  achievable any other way.
- `execute()`'s live testnet verification stops at "rejects correctly
  before eta," reproducible via
  `contracts/timelock/scripts/testnet_smoke_test.sh`. Real elapsed 24h
  wait time cannot be scripted against a live network within a working
  session, so the "eta reached, target genuinely mutates via the real
  cross-call" path is proven instead by a unit test
  (`execute_after_eta_invokes_target_via_real_cross_call`) that advances
  the simulated ledger clock and calls a real, separately-compiled target
  contract using the identical self-authorizing pattern `risk-engine`
  relies on in production, not a hand-rolled stand-in for what
  `invoke_contract` does.
- `risk-engine`'s deployed testnet address changed twice while building
  this (once to add admin gating, once to add `transfer_admin`). The
  earlier `check_and_trip`/`keeper_advance_state` transition matrix from
  `adr/0006` doesn't carry over automatically to a new address, so it was
  re-verified live against the final one.
