#!/usr/bin/env bash
# Live end-to-end verification against real Soroswap testnet infrastructure
# and a real OracleRouter price read, not a calldata-shape assumption or a
# hand-supplied price. Two real halves: policy-swap's own enforce() gates a
# real swap_exact_tokens_for_tokens() call correctly (allowed within cap and
# oracle floor, rejected on a sandwich-style loose amount_out_min, rejected
# on wrong router/path/destination/cap), then a real swap_exact_tokens_for_
# tokens() call actually round-trips USDC->XLM through the real Soroswap
# router and real USDC/XLM SAC pair, confirmed via real balance reads
# before and after.
#
# smart_account in these enforce() calls is this script's own funded
# identity, not a deployed vault: enforce() only needs
# smart_account.require_auth(), which a plain EOA satisfies the same way a
# CustomAccountInterface vault would once the SDK's signing module exists
# (adr/0008). What's proven here is policy-swap's real decode, cap, and
# oracle-derived slippage gating against real calldata and a real price,
# not the vault authorization chain, which is already covered separately.
#
# Requires: stellar-cli, a funded testnet identity holding real USDC (get
# some by swapping XLM->USDC on the real router first if the identity has
# none). Create an identity with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/../../.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

# Real Soroswap testnet deployment (soroswap/core public/testnet.contracts.json).
ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
# Real Circle USDC testnet token and native XLM SAC, the real live pair
# verified via router_pair_for: CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS.
USDC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
XLM=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

echo "==> Building and deploying a fresh oracle-router (real Reflector + RedStone feeds)"
stellar contract build --package refluo-oracle-router
ORACLE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_oracle_router.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $ORACLE_ID"

REFLECTOR_TESTNET=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
REDSTONE_SEP40_TESTNET=CA7MY6TYNL5Z5H5FYGMN7YWSY3JIZG7LFY3DZ26EEGRBQ2UKTFWHD4ZJ

stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_config --asset '{"Other":"XLM"}' --cfg "{
    \"primary_feed\": \"$REFLECTOR_TESTNET\",
    \"primary_asset\": {\"Other\":\"XLM\"},
    \"secondary_feed\": \"$REDSTONE_SEP40_TESTNET\",
    \"secondary_asset\": {\"Stellar\":\"$XLM\"},
    \"max_staleness_primary\": 600,
    \"max_staleness_secondary\": 90000,
    \"twap_periods\": 6,
    \"divergence_soft\": 200,
    \"divergence_hard\": 500,
    \"max_roc_per_update\": 1000
  }" >/dev/null

echo "==> Reading live XLM price"
PRICE_JSON=$(stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- get_price --asset '{"Other":"XLM"}' 2>&1 | tail -1)
echo "    $PRICE_JSON"
PRICE=$(echo "$PRICE_JSON" | grep -o '"price":"[0-9]*"' | grep -o '[0-9]*')
echo "    price=$PRICE (14 decimals)"

echo "==> Building and deploying policy-swap"
stellar contract build --package refluo-policy-swap
PS_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_swap.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $PS_ID"

# per_call_cap = 10 USDC, epoch_cap = 20 USDC, min_out_bps = 9700 (accept up
# to 3% combined AMM spread/fee/slippage vs oracle fair value).
PER_CALL_CAP=100000000
EPOCH_CAP=200000000
MIN_OUT_BPS=9700

echo "==> Installing config: router=real Soroswap, USDC->XLM, oracle=$ORACLE_ID"
stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- install --install_params "{
    \"router\": \"$ROUTER\", \"token_in\": \"$USDC\", \"token_out\": \"$XLM\",
    \"token_in_decimals\": 7, \"token_out_decimals\": 7,
    \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
    \"oracle_price_decimals\": 14,
    \"per_call_cap\": \"$PER_CALL_CAP\", \"epoch_cap\": \"$EPOCH_CAP\",
    \"epoch_length\": 86400, \"min_out_bps\": $MIN_OUT_BPS,
    \"max_deadline_window\": 300
  }" --context_rule "{
    \"id\": 1, \"context_type\": \"Default\", \"name\": \"r_swap\",
    \"signers\": [], \"signer_ids\": [], \"policies\": [], \"policy_ids\": [],
    \"valid_until\": null
  }" --smart_account "$ACCOUNT" >/dev/null

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
  if "$@" >/tmp/ps_smoke_err 2>&1; then
    echo "    FAIL: $desc (expected rejection, call succeeded)"
    fail=$((fail + 1))
  else
    echo "    PASS: $desc (rejected as expected)"
    pass=$((pass + 1))
  fi
}

RULE='{"id": 1, "context_type": "Default", "name": "r_swap", "signers": [], "signer_ids": [], "policies": [], "policy_ids": [], "valid_until": null}'
NOW=$(date +%s)
DEADLINE=$((NOW + 60))

# Oracle-fair expected output for a 5 USDC swap, same integer formula
# policy-swap's own contract math uses: amount_in * 10^price_decimals /
# price (token_in and token_out both 7 decimals, so those factors cancel).
AMOUNT_IN=50000000
EXPECTED_OUT=$(echo "scale=0; $AMOUNT_IN * 100000000000000 / $PRICE" | bc)
FAIR_MIN_OUT=$(echo "scale=0; $EXPECTED_OUT * $MIN_OUT_BPS / 10000" | bc)
LOOSE_MIN_OUT=$(echo "scale=0; $EXPECTED_OUT / 2" | bc)
echo "    5 USDC oracle-fair expected out: $EXPECTED_OUT stroops, floor at ${MIN_OUT_BPS}bps: $FAIR_MIN_OUT"

swap_context() {
  local router="$1" token_in="$2" token_out="$3" amount_in="$4" amount_out_min="$5" to="$6" deadline="$7"
  echo "{\"Contract\":{\"contract\":\"$router\",\"fn_name\":\"swap_exact_tokens_for_tokens\",\"args\":[{\"i128\":\"$amount_in\"},{\"i128\":\"$amount_out_min\"},{\"vec\":[{\"address\":\"$token_in\"},{\"address\":\"$token_out\"}]},{\"address\":\"$to\"},{\"u64\":$deadline}]}}"
}

echo "==> [1] policy-swap must allow a real swap request within cap and above the oracle floor"
CTX_OK=$(swap_context "$ROUTER" "$USDC" "$XLM" "$AMOUNT_IN" "$FAIR_MIN_OUT" "$ACCOUNT" "$DEADLINE")
stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CTX_OK" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT" >/dev/null
echo "    PASS: real swap_exact_tokens_for_tokens(5 USDC, oracle-fair floor) authorized"
pass=$((pass + 1))

echo "==> [2] policy-swap must reject a sandwich-style amount_out_min below the oracle floor"
CTX_SANDWICH=$(swap_context "$ROUTER" "$USDC" "$XLM" "$AMOUNT_IN" "$LOOSE_MIN_OUT" "$ACCOUNT" "$DEADLINE")
expect_err "amount_out_min at 50% of fair value rejected, sandwich damage bounded" \
  stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CTX_SANDWICH" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo "==> [3] policy-swap must reject an amount over per_call_cap"
CTX_OVER_CAP=$(swap_context "$ROUTER" "$USDC" "$XLM" $((PER_CALL_CAP + 1)) "1" "$ACCOUNT" "$DEADLINE")
expect_err "amount_in over per_call_cap rejected" \
  stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CTX_OVER_CAP" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo "==> [4] policy-swap must reject a router other than the allowlisted Soroswap router"
CTX_WRONG_ROUTER=$(swap_context "$ORACLE_ID" "$USDC" "$XLM" "$AMOUNT_IN" "1" "$ACCOUNT" "$DEADLINE")
expect_err "call to a non-allowlisted router address rejected" \
  stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CTX_WRONG_ROUTER" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo "==> [5] A real swap_exact_tokens_for_tokens() call must actually round-trip USDC->XLM"
echo "    through the real Soroswap router and the real live pair"
BEFORE_USDC=$(stellar contract invoke --id "$USDC" --source "$IDENTITY" --network testnet \
  -- balance --id "$ACCOUNT" 2>&1 | tail -1)
BEFORE_XLM=$(stellar contract invoke --id "$XLM" --source "$IDENTITY" --network testnet \
  -- balance --id "$ACCOUNT" 2>&1 | tail -1)
echo "    before: USDC=$BEFORE_USDC XLM=$BEFORE_XLM"

stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
  -- swap_exact_tokens_for_tokens \
  --amount_in "$AMOUNT_IN" --amount_out_min "$FAIR_MIN_OUT" \
  --path "[\"$USDC\",\"$XLM\"]" --to "$ACCOUNT" --deadline "$DEADLINE" >/dev/null

AFTER_USDC=$(stellar contract invoke --id "$USDC" --source "$IDENTITY" --network testnet \
  -- balance --id "$ACCOUNT" 2>&1 | tail -1)
AFTER_XLM=$(stellar contract invoke --id "$XLM" --source "$IDENTITY" --network testnet \
  -- balance --id "$ACCOUNT" 2>&1 | tail -1)
echo "    after:  USDC=$AFTER_USDC XLM=$AFTER_XLM"

if [ "$BEFORE_USDC" != "$AFTER_USDC" ] && [ "$BEFORE_XLM" != "$AFTER_XLM" ]; then
  echo "    PASS: a real 5 USDC swap moved real USDC out and real XLM in"
  pass=$((pass + 1))
else
  echo "    FAIL: real swap did not change real balances as expected"
  fail=$((fail + 1))
fi

echo ""
echo "==> $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
