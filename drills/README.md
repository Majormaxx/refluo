# drills

Scripted adversarial scenarios, run as part of the test/quality pipeline
as each piece of functionality lands, not held back until an audit is near.

Planned and in-progress drills:

- **Refluo disappears drill**: simulate total loss of keeper infrastructure
  and dashboard availability; verify an admin acting alone can uninstall
  all policies and recover the vault with zero off-chain dependency.
  Proven in two stages so far, live testnet deployment (`vault` and
  `policy-admin-threshold`, first ever for both) confirms a real 2-of-3
  admin threshold bootstraps correctly and enforces 2-of-3 in isolation;
  `contracts/integration-tests` proves the uninstall wiring cross-contract.
  What's not built: the actual multi-signer transaction submission, which
  is genuinely blocked on the SDK's signing module, not deferred by
  choice. Plain `stellar-cli` has no built-in way to construct the nested
  authorization entries a real 2-of-3 call needs against a
  `stellar-accounts` CustomAccountInterface vault. See `adr/0008`.
- **Manipulated-feed drill** (`yieldblox_drill.sh`, named for the exploit
  this defends against): feed one oracle input a 100x price spike and
  confirm the router refuses to treat it as real, deployments stop,
  recalls keep working, and the system comes back on its own once the
  feed recovers. Live on testnet: a real `mock-price-feed` contract
  stands in for the attacker-controlled feed (a real testnet feed can't
  be made to lie on demand), seeded to match Reflector's real live price,
  then spiked. 7/7 assertions passed on a real run: Healthy before, real
  cross-contract Degraded and RiskEngine Emergency after the spike with
  deployment blocked, real auto-resume once the feed is reset. Recalls
  staying available is verified by source inspection, `policy-recall`
  contains zero references to oracle status anywhere, so nothing there
  can be blocked by one. See `adr/0009`.
- **XLM auto-swap drill**: sandwich/slippage attack simulation against the
  Tier 0 fee-floor top-up swap path. Not started, depends on the keeper's
  sentinel loop, which doesn't exist yet.
- **Utilization spike drill**: scripted 80%→95% Blend reserve utilization
  against real testnet pools, assert pre-emptive drain fires before a
  withdrawal failure would. Not started as a live drill script.
  `risk-engine`'s tier state machine is built and live-verified, including
  the 85% preemptive-drain threshold; the 92% full-drain escalation this
  drill would exercise isn't implemented yet either.
- **Keeper-key-compromise drill**: quantify max griefing damage from a
  compromised recall key against the rate limits in `policy-recall`. Not
  started as a standalone drill, but `policy-recall`'s own property tests
  already prove the rate-limit-monotone invariant this drill would
  quantify against.
