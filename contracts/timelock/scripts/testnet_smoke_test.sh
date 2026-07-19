#!/usr/bin/env bash
# Live end-to-end verification against real testnet infrastructure, not
# mocks. Deploys Timelock and a fresh RiskEngine to Stellar testnet, hands
# RiskEngine's fee governance off to Timelock's own contract address via
# transfer_admin, then proves live: a direct call from an EOA is rejected
# once governance has moved, a real proposal's args decode and execute
# rejects before the 24h delay elapses, and cancel actually removes a
# pending proposal. Full 24h elapsed-time execution isn't exercised here,
# real time can't be fast-forwarded on a live network; that path is
# covered by a real cross-contract-call unit test instead (see adr/0007).
#
# Requires: stellar-cli, a funded testnet identity. Create one with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/../../.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

ORACLE_ID=CBDVIRUWVWC7M2ZJH7XDJNYCURUPQMO4F3AIX24CMY43QRY5V3RCN2MX
USDC_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

echo "==> Building timelock and risk-engine wasm"
stellar contract build --package refluo-timelock
stellar contract build --package refluo-risk-engine

echo "==> Deploying timelock"
TL_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_timelock.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $TL_ID"

echo "==> Deploying a fresh health-monitor and risk-engine so this run owns its own state"
HM_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
RE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_risk_engine.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    health-monitor at $HM_ID, risk-engine at $RE_ID"

stellar contract invoke --id "$HM_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init_guardians --admin "$ACCOUNT" --guardians "[\"$ACCOUNT\"]" >/dev/null

CFG="{
  \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
  \"health_monitor\": \"$HM_ID\", \"usdc_token\": \"$USDC_ID\", \"keeper\": \"$ACCOUNT\",
  \"tier0_bounds_min\": \"5000000000\", \"tier0_bounds_max\": \"20000000000\",
  \"critical_floor\": \"1000000000\", \"tvl_cap\": \"1000000000000\", \"preemptive_util_bps\": 8500, \"full_drain_util_bps\": 9200
}"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --account "$ACCOUNT" --cfg "$CFG" --tier0_target "10000000000" >/dev/null

echo "==> init timelock (admin=$ACCOUNT, can cancel)"
stellar contract invoke --id "$TL_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --admin "$ACCOUNT" >/dev/null

echo "==> bootstrap risk-engine's fee admin to ourselves, then hand it off to timelock"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init_admin --admin "$ACCOUNT" >/dev/null
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- transfer_admin --current_admin "$ACCOUNT" --new_admin "$TL_ID" >/dev/null

pass=0
fail=0
check() {
  local desc="$1" expect="$2" actual="$3"
  if [ "$expect" = "$actual" ]; then
    echo "    PASS: $desc"
    pass=$((pass + 1))
  else
    echo "    FAIL: $desc (expected $expect, got $actual)"
    fail=$((fail + 1))
  fi
}
expect_err() {
  local desc="$1"; shift
  if "$@" >/tmp/tl_smoke_err 2>&1; then
    echo "    FAIL: $desc (expected rejection, call succeeded)"
    fail=$((fail + 1))
  else
    echo "    PASS: $desc (rejected as expected)"
    pass=$((pass + 1))
  fi
}

echo "==> [1] direct set_fee_bps from the EOA must now be rejected"
expect_err "governance moved to timelock, EOA can no longer set the fee directly" \
  stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_fee_bps --admin "$ACCOUNT" --new_fee_bps 1500

echo "==> [2] propose a real fee raise through timelock"
stellar contract invoke --id "$TL_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- propose --proposer "$ACCOUNT" --target "$RE_ID" --fn_name "set_fee_bps" \
  --args "[{\"address\": \"$TL_ID\"}, {\"u32\": 1500}]" >/dev/null

echo "==> [3] execute before the 24h delay elapses must be rejected"
expect_err "execute rejects before eta" \
  stellar contract invoke --id "$TL_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- execute --id 0
FEE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- fee_bps 2>&1 | tail -1)
check "fee_bps unchanged after a rejected early execute" "0" "$FEE"

echo "==> [4] admin cancels the pending proposal"
stellar contract invoke --id "$TL_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- cancel --id 0 --admin "$ACCOUNT" >/dev/null
expect_err "get_proposal fails once cancelled" \
  stellar contract invoke --id "$TL_ID" --source "$IDENTITY" --network testnet -- get_proposal --id 0

echo ""
echo "==> $pass passed, $fail failed"
echo "Note: full 24h-elapsed execute() success is verified in the unit"
echo "suite (real cross-contract call, real ledger-clock advance), not"
echo "here; this network can't be fast-forwarded. See adr/0007."
if [ "$fail" -ne 0 ]; then
  exit 1
fi
