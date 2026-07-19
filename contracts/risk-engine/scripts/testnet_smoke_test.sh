#!/usr/bin/env bash
# Live end-to-end verification against real testnet infrastructure, not
# mocks. Deploys HealthMonitor and RiskEngine to Stellar testnet, wires
# RiskEngine to a real already-deployed OracleRouter and the real Circle
# testnet USDC SAC, then drives every SystemState transition and rejection
# path through real cross-contract calls: a real oracle read, a real
# HealthMonitor pause/resume, and a real on-chain USDC balance read.
#
# Requires: stellar-cli, a funded testnet identity. Create one with:
#   stellar keys generate refluo-testnet --network testnet --fund
#
# The real testnet USDC SAC wraps a classic Stellar asset (issued by
# Circle), so balance() traps without a trustline instead of returning 0;
# this script establishes one. Getting that trustline funded with real
# USDC requires Circle's browser/captcha-gated faucet, so the
# balance-sufficient recovery path (Emergency/Paused -> Normal) isn't
# exercised here; it's covered in the unit test suite against a real
# Stellar Asset Contract test double instead. Every other transition,
# including every rejection, is driven end to end against real contracts.
set -euo pipefail

cd "$(dirname "$0")/../../.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

# Already-deployed, live-verified OracleRouter configured for XLM against
# real Reflector and RedStone testnet feeds (see
# contracts/oracle-router/scripts/testnet_smoke_test.sh).
ORACLE_ID=CBDVIRUWVWC7M2ZJH7XDJNYCURUPQMO4F3AIX24CMY43QRY5V3RCN2MX
# Real testnet USDC SAC, wraps USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5.
USDC_ID=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

echo "==> Building health-monitor and risk-engine wasm"
stellar contract build --package refluo-health-monitor
stellar contract build --package refluo-risk-engine

echo "==> Deploying health-monitor"
HM_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $HM_ID"

echo "==> Deploying risk-engine"
RE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_risk_engine.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $RE_ID"

echo "==> init_guardians: $ACCOUNT is both admin and sole guardian"
stellar contract invoke --id "$HM_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init_guardians --admin "$ACCOUNT" --guardians "[\"$ACCOUNT\"]" >/dev/null

CFG="{
  \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
  \"health_monitor\": \"$HM_ID\", \"usdc_token\": \"$USDC_ID\", \"keeper\": \"$ACCOUNT\",
  \"tier0_bounds_min\": \"5000000000\", \"tier0_bounds_max\": \"20000000000\",
  \"critical_floor\": \"1000000000\", \"tvl_cap\": \"1000000000000\", \"preemptive_util_bps\": 8500, \"full_drain_util_bps\": 9200
}"

echo "==> init risk-engine (account=keeper=$ACCOUNT)"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --account "$ACCOUNT" --cfg "$CFG" --tier0_target "10000000000" >/dev/null

echo "==> Establishing USDC trustline (no-op if it already exists); a real"
echo "    vault needs one to ever hold USDC, this isn't a workaround"
stellar tx new change-trust --source-account "$IDENTITY" --network testnet \
  --line "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" >/dev/null 2>&1 || true

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
  if "$@" >/tmp/re_smoke_err 2>&1; then
    echo "    FAIL: $desc (expected rejection, call succeeded)"
    fail=$((fail + 1))
  else
    echo "    PASS: $desc (rejected as expected)"
    pass=$((pass + 1))
  fi
}

echo "==> [1] check_and_trip against real Healthy oracle + real 0 USDC balance"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- check_and_trip --account "$ACCOUNT" >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "real 0 balance < critical_floor trips Emergency(2)" "2" "$STATE"

echo "==> [2] guardian pauses HealthMonitor for real, check_and_trip escalates"
stellar contract invoke --id "$HM_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- pause --guardian "$ACCOUNT" >/dev/null
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- check_and_trip --account "$ACCOUNT" >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "real HealthMonitor pause escalates to Paused(3)" "3" "$STATE"

echo "==> [3] admin resumes early; recovery to Normal still rejected (real balance still 0)"
stellar contract invoke --id "$HM_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- resume_early --admin "$ACCOUNT" >/dev/null
expect_err "keeper recovery to Normal rejected while real balance below critical_floor" \
  stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- keeper_advance_state --account "$ACCOUNT" --keeper "$ACCOUNT" --to 0

echo "==> [4] reset to Normal, drive PreemptiveDrain via keeper utilization attestation"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --account "$ACCOUNT" --cfg "$CFG" --tier0_target "10000000000" >/dev/null
expect_err "utilization attestation below threshold (8000 < 8500) rejected" \
  stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- keeper_advance_state --account "$ACCOUNT" --keeper "$ACCOUNT" --to 1 --utilization_bps 8000
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- keeper_advance_state --account "$ACCOUNT" --keeper "$ACCOUNT" --to 1 --utilization_bps 9000 >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "utilization attestation above threshold moves to PreemptiveDrain(1)" "1" "$STATE"

echo "==> [5] full drain: utilization above full_drain_util_bps (9200) reaches Emergency directly"
expect_err "utilization between thresholds (9000 < 9200) rejected for Emergency" \
  stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- keeper_advance_state --account "$ACCOUNT" --keeper "$ACCOUNT" --to 2 --utilization_bps 9000
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- keeper_advance_state --account "$ACCOUNT" --keeper "$ACCOUNT" --to 2 --utilization_bps 9500 >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "full-drain utilization attestation moves to Emergency(2)" "2" "$STATE"

echo "==> [6] init_with_profile: Aggressive must resolve to its real 90%/97% thresholds"
PROFILE_CFG="{
  \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
  \"health_monitor\": \"$HM_ID\", \"usdc_token\": \"$USDC_ID\", \"keeper\": \"$ACCOUNT\",
  \"tier0_bounds_min\": \"5000000000\", \"tier0_bounds_max\": \"20000000000\",
  \"critical_floor\": \"1000000000\", \"tvl_cap\": \"1000000000000\",
  \"preemptive_util_bps\": 1, \"full_drain_util_bps\": 2
}"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init_with_profile --account "$ACCOUNT" --profile 2 --cfg "$PROFILE_CFG" --tier0_target "10000000000" >/dev/null
PREEMPTIVE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- config --account "$ACCOUNT" 2>&1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['preemptive_util_bps'])")
FULL_DRAIN=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- config --account "$ACCOUNT" 2>&1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['full_drain_util_bps'])")
check "Aggressive profile resolves to preemptive_util_bps=9000, not the caller's 1" "9000" "$PREEMPTIVE"
check "Aggressive profile resolves to full_drain_util_bps=9700, not the caller's 2" "9700" "$FULL_DRAIN"

echo ""
echo "==> $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
