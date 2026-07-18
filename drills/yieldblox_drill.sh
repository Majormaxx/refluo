#!/usr/bin/env bash
# Live YieldBlox drill, named for the exploit this defends against: a
# single manipulated feed reporting a huge price spike. Deploys a real,
# admin-settable mock feed (refluo-mock-price-feed) as OracleRouter's
# secondary, seeds it matching Reflector's real live price, confirms
# Healthy, spikes it 100x, confirms the router refuses the spike
# (Degraded) and RiskEngine correctly blocks all deployment, then resets
# the feed and confirms the router recovers on its own, no admin action,
# no stored "tripped" flag to reset. RiskEngine's own SystemState does
# NOT auto-recover past this point, by design (adr/0006): a keeper must
# deliberately confirm recovery via keeper_advance_state, this drill only
# exercises the oracle-level auto-resume, not that keeper-gated step.
#
# Requires: stellar-cli, a funded testnet identity. Create one with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

REFLECTOR_ID=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63

echo "==> Building mock-price-feed, oracle-router, health-monitor, risk-engine"
stellar contract build --package refluo-mock-price-feed
stellar contract build --package refluo-oracle-router
stellar contract build --package refluo-health-monitor
stellar contract build --package refluo-risk-engine

echo "==> Reading Reflector's real live XLM price to seed the mock matching it"
REAL_PRICE=$(stellar contract invoke --id "$REFLECTOR_ID" --source "$IDENTITY" --network testnet \
  -- lastprice --asset '{"Other":"XLM"}' 2>&1 | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['price'])")
echo "    real Reflector XLM price: $REAL_PRICE"

echo "==> Deploying mock-price-feed, seeded to match the real feed"
MOCK_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_mock_price_feed.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
stellar contract invoke --id "$MOCK_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --admin "$ACCOUNT" --initial_price "$REAL_PRICE" --timestamp "$(date +%s)" >/dev/null
echo "    mock deployed at $MOCK_ID"

echo "==> Deploying a fresh oracle-router, primary=real Reflector, secondary=mock"
ORACLE_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_oracle_router.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_config --asset '{"Other":"XLM"}' --cfg "{
    \"primary_feed\": \"$REFLECTOR_ID\", \"primary_asset\": {\"Other\":\"XLM\"},
    \"secondary_feed\": \"$MOCK_ID\", \"secondary_asset\": {\"Other\":\"XLM\"},
    \"max_staleness_primary\": 600, \"max_staleness_secondary\": 600,
    \"twap_periods\": 6, \"divergence_soft\": 200, \"divergence_hard\": 500,
    \"max_roc_per_update\": 1000
  }" >/dev/null

echo "==> Deploying fresh health-monitor + risk-engine wired to this oracle-router"
HM_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_health_monitor.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
stellar contract invoke --id "$HM_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init_guardians --admin "$ACCOUNT" --guardians "[\"$ACCOUNT\"]" >/dev/null

RE_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_risk_engine.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
# critical_floor=0 isolates this drill to the oracle-status path; the
# balance-driven Emergency path is already live-verified in adr/0006.
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- init --account "$ACCOUNT" --cfg "{
    \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
    \"health_monitor\": \"$HM_ID\", \"usdc_token\": \"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA\",
    \"keeper\": \"$ACCOUNT\", \"tier0_bounds_min\": \"1\", \"tier0_bounds_max\": \"1000000000000\",
    \"critical_floor\": \"0\", \"tvl_cap\": \"1000000000000\", \"preemptive_util_bps\": 8500
  }" --tier0_target "1" >/dev/null

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

echo "==> [1] Before the spike: mock matches real Reflector, status must be Healthy"
QUOTE=$(stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- get_price --asset '{"Other":"XLM"}' 2>&1 | tail -1)
STATUS=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
check "status Healthy before any manipulation" "0" "$STATUS"

echo "==> [2] check_and_trip while healthy: RiskEngine must stay Normal, deployment allowed"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- check_and_trip --account "$ACCOUNT" >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "SystemState Normal before the spike" "0" "$STATE"
ALLOWED=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- deploy_allowed --account "$ACCOUNT" --amount "1" 2>&1 | tail -1)
check "deploy_allowed true before the spike" "true" "$ALLOWED"

echo "==> [3] Spiking the mock secondary feed 100x, a real cross-call OracleRouter must refuse"
SPIKED=$(python3 -c "print(int(\"$REAL_PRICE\") * 100)")
stellar contract invoke --id "$MOCK_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_price --admin "$ACCOUNT" --price "$SPIKED" --timestamp "$(date +%s)" >/dev/null
QUOTE=$(stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- get_price --asset '{"Other":"XLM"}' 2>&1 | tail -1)
STATUS=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
check "status Degraded after a real 100x single-feed spike" "2" "$STATUS"

echo "==> [4] check_and_trip after the spike: RiskEngine must escalate, deployment blocked"
stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- check_and_trip --account "$ACCOUNT" >/dev/null
STATE=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- state --account "$ACCOUNT" 2>&1 | tail -1)
check "SystemState Emergency after the spike" "2" "$STATE"
ALLOWED=$(stellar contract invoke --id "$RE_ID" --source "$IDENTITY" --network testnet -- deploy_allowed --account "$ACCOUNT" --amount "1" 2>&1 | tail -1)
check "deploy_allowed false after the spike (zero deployments)" "false" "$ALLOWED"

echo "==> [5] Resetting the feed: OracleRouter must recover on its own, no admin action"
stellar contract invoke --id "$MOCK_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_price --admin "$ACCOUNT" --price "$REAL_PRICE" --timestamp "$(date +%s)" >/dev/null
QUOTE=$(stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- get_price --asset '{"Other":"XLM"}' 2>&1 | tail -1)
STATUS=$(echo "$QUOTE" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
check "OracleRouter auto-resumes Healthy once the feed recovers, no reset call needed" "0" "$STATUS"

echo ""
echo "==> $pass passed, $fail failed"
echo "Note: RiskEngine's SystemState stays Emergency here by design, recovery"
echo "is keeper-gated (adr/0006), not automatic; this drill only proves the"
echo "oracle-level auto-resume, not RiskEngine's separate recovery path."
if [ "$fail" -ne 0 ]; then
  exit 1
fi
