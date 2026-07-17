# drills

Scripted adversarial scenarios, run as part of the test/quality pipeline
before each phase exit (not just before audit).

Planned drills:

- **YieldBlox drill** (Phase 2 exit): mock secondary oracle feed at 100x,
  assert DEGRADED, assert zero new deployments, assert recalls still work,
  assert auto-resume after recovery.
- **Refluo disappears drill** (Phase 1 exit): simulate total loss of keeper
  infrastructure and dashboard availability; verify an admin 2-of-3 can
  uninstall all policies and withdraw 100% of Tier 0 + recall 100% of
  Tier 1 funds using only `stellar-cli` and raw contract addresses — no
  SDK, no dashboard, no keeper. See `refluo-prd-unified.md` §11 (local).
- **XLM auto-swap drill** (Phase 3 exit): sandwich/slippage attack
  simulation against the Tier 0 fee-floor top-up swap path.
- **Utilization spike drill** (Phase 3 exit): scripted 80%→95% Blend
  reserve utilization against real testnet pools, assert pre-emptive drain
  fires before a withdrawal failure would.
- **Keeper-key-compromise drill** (Phase 1 exit): quantify max griefing
  damage from a compromised recall key against the rate limits in
  `policy-recall`.

Not started. Placeholder so the Phase 0 workspace layout matches the
architecture doc.
