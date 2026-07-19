# ADR 0013: Risk profiles as a real on-chain preset, not an SDK convention

Status: accepted. Date: 2026-07.

## Decision

`RiskEngine` gained `RiskProfile` (Conservative/Balanced/Aggressive) and
`init_with_profile(account, profile, cfg, tier0_target)`. The profile
resolves `preemptive_util_bps`/`full_drain_util_bps` to real hardcoded
presets (75%/85%, 85%/92%, 90%/97%) and overwrites whatever values `cfg`
carries for those two fields, the caller cannot smuggle a different pair
of thresholds through by naming a profile and setting the fields anyway.
Every other field of `TierConfig` (addresses, `tvl_cap`,
`critical_floor`, `tier0_bounds_min`/`max`) is used as given, none of it
is a function of risk appetite, all of it depends on the vault's actual
capital. The plain `init()` entry point is unchanged and still accepts
explicit thresholds directly, for anyone who wants that.

Live-verified on testnet: `init_with_profile` called with `Aggressive`
and a `cfg` carrying deliberately wrong threshold values (1, 2); `config()`
read back afterward shows the real preset (9000, 9700), not the caller's
numbers.

## Why

The PRD describes risk profiles as something a dashboard "surfaces" and
an operator "sets" at go-live, which reads as an SDK/dashboard-level
convenience, not a contract concern. Building it that way would
mean the actual security-relevant numbers, how much utilization a vault
tolerates before draining, live in a TypeScript config object or a
database row, auditable only by trusting whichever off-chain system
constructed the `TierConfig` a given vault was actually initialized with.
Putting the presets on-chain means anyone can verify from `RiskEngine`'s
own deployed bytecode what "Aggressive" actually means for this vault,
the same reasoning `adr/0002` already applied to `MAX_FEE_BPS`: a number
a customer can verify on-chain, not a promise from a UI.

## Consequences

- The SDK, once built, still needs to expose profile selection as a UI
  concept, this ADR doesn't remove that work. What it removes is the SDK
  ever being the source of truth for what a profile's thresholds
  actually are.
- Presets are fixed constants in `RiskProfile::thresholds()`, changing
  them changes behavior for every vault using `init_with_profile` on the
  next deployment, not retroactively for already-initialized vaults
  (`TierConfig` is stored per-account at `init` time, same as every other
  field).
