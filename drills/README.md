# drills

Scripted adversarial scenarios, run as part of the test/quality pipeline
as each piece of functionality lands (not just before audit).

Planned and in-progress drills:

- **Refluo disappears drill**: simulate total loss of keeper infrastructure
  and dashboard availability; verify an admin acting alone can uninstall
  all policies and recover the vault with zero off-chain dependency. A
  first version of this exists today in `../contracts/integration-tests`
  (admin removes every policy-bearing context rule using only the vault's
  own client, cross-contract `uninstall` calls verified). The full version
  described here — real `stellar-cli` commands against a live/local
  network withdrawing 100% of Tier 0 + recalling 100% of Tier 1 — needs a
  funded token and a real deployment to run against, not yet built.
- **YieldBlox drill**: mock secondary oracle feed at 100x, assert DEGRADED,
  assert zero new deployments, assert recalls still work, assert
  auto-resume after recovery. Not started — depends on OracleRouter's
  read-algorithm logic, which is blocked on RedStone verification.
- **XLM auto-swap drill**: sandwich/slippage attack simulation against the
  Tier 0 fee-floor top-up swap path. Not started.
- **Utilization spike drill**: scripted 80%→95% Blend reserve utilization
  against real testnet pools, assert pre-emptive drain fires before a
  withdrawal failure would. Not started — depends on RiskEngine's tier
  state machine, not yet implemented.
- **Keeper-key-compromise drill**: quantify max griefing damage from a
  compromised recall key against the rate limits in `policy-recall`. Not
  started as a standalone drill, but `policy-recall`'s own property tests
  already prove the rate-limit-monotone invariant this drill would
  quantify against.
