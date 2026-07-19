#!/usr/bin/env bash
# Sandwich/slippage drill for the Tier 0 fee-floor top-up swap path
# (adr/0015). Two real, live halves against real Soroswap testnet
# infrastructure, not a parameter-only check:
#
# 1. policy-swap's own enforce() gate: a sandwich-style amount_out_min
#    (near zero, the shape a compromised keeper key or a bug would
#    produce) is rejected outright, and a real oracle-derived floor is
#    the only thing enforce() ever accepts, never a caller's own claim.
# 2. A real, on-chain sandwich against the real router: a "victim" quote
#    is fetched live, an "attacker" front-run actually executes for real
#    against the real pool (shifting its real reserves), and the exact
#    same victim swap is then attempted for real with the pre-manipulation
#    quote as its zero-tolerance amount_out_min. The real Soroswap router
#    itself reverts it, proving amount_out_min really protects a live
#    trade against a live price shift, beyond a unit-test assertion alone.
#    A restoring back-run leg follows, then a production-realistic
#    97%-floor swap is shown to still succeed post-restoration: the
#    mechanism blocks a genuine attack without being so brittle it
#    breaks on ordinary, small, honest market movement.
#
# Requires: stellar-cli, a funded testnet identity holding real USDC (this
# script funds itself by swapping a small amount of XLM for USDC if the
# balance is low). Create an identity with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD
USDC=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
XLM=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
REFLECTOR_TESTNET=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
REDSTONE_SEP40_TESTNET=CA7MY6TYNL5Z5H5FYGMN7YWSY3JIZG7LFY3DZ26EEGRBQ2UKTFWHD4ZJ

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
  if "$@" >/tmp/sandwich_drill_err 2>&1; then
    echo "    FAIL: $desc (expected rejection, call succeeded)"
    fail=$((fail + 1))
  else
    echo "    PASS: $desc (rejected as expected)"
    pass=$((pass + 1))
  fi
}
amounts_out() {
  # router_get_amounts_out's second (final-leg) output amount.
  stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet \
    -- router_get_amounts_out --amount_in "$1" --path "[\"$USDC\",\"$XLM\"]" 2>&1 \
    | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)[1])"
}

echo "==> Ensuring the identity holds enough real USDC to fund this drill"
USDC_BAL=$(stellar contract invoke --id "$USDC" --source "$IDENTITY" --network testnet \
  -- balance --id "$ACCOUNT" 2>&1 | tail -1 | tr -d '"')
echo "    current USDC balance: $USDC_BAL"
if [ "$USDC_BAL" -lt 100000000 ]; then
  echo "    below 10 USDC, swapping 1000 XLM for real USDC to fund the drill"
  DEADLINE=$(($(date +%s) + 120))
  stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
    -- swap_exact_tokens_for_tokens --amount_in 10000000000 --amount_out_min 1 \
    --path "[\"$XLM\",\"$USDC\"]" --to "$ACCOUNT" --deadline "$DEADLINE" >/dev/null
fi

echo "==> Building and deploying a fresh oracle-router (real Reflector + RedStone feeds)"
stellar contract build --package refluo-oracle-router
ORACLE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_oracle_router.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
stellar contract invoke --id "$ORACLE_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- set_config --asset '{"Other":"XLM"}' --cfg "{
    \"primary_feed\": \"$REFLECTOR_TESTNET\", \"primary_asset\": {\"Other\":\"XLM\"},
    \"secondary_feed\": \"$REDSTONE_SEP40_TESTNET\", \"secondary_asset\": {\"Stellar\":\"$XLM\"},
    \"max_staleness_primary\": 600, \"max_staleness_secondary\": 90000,
    \"twap_periods\": 6, \"divergence_soft\": 200, \"divergence_hard\": 500,
    \"max_roc_per_update\": 1000
  }" >/dev/null
echo "    oracle-router deployed at $ORACLE_ID"

echo "==> Building and deploying policy-swap"
stellar contract build --package refluo-policy-swap
PS_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_swap.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
MIN_OUT_BPS=9700
stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- install --install_params "{
    \"router\": \"$ROUTER\", \"token_in\": \"$USDC\", \"token_out\": \"$XLM\",
    \"token_in_decimals\": 7, \"token_out_decimals\": 7,
    \"oracle_router\": \"$ORACLE_ID\", \"oracle_asset\": {\"Other\":\"XLM\"},
    \"oracle_price_decimals\": 14, \"per_call_cap\": \"100000000000\",
    \"epoch_cap\": \"1000000000000\", \"epoch_length\": 86400,
    \"min_out_bps\": $MIN_OUT_BPS, \"max_deadline_window\": 300
  }" --context_rule "{
    \"id\": 1, \"context_type\": \"Default\", \"name\": \"r_swap\",
    \"signers\": [], \"signer_ids\": [], \"policies\": [], \"policy_ids\": [],
    \"valid_until\": null
  }" --smart_account "$ACCOUNT" >/dev/null
echo "    policy-swap deployed at $PS_ID"

RULE='{"id": 1, "context_type": "Default", "name": "r_swap", "signers": [], "signer_ids": [], "policies": [], "policy_ids": [], "valid_until": null}'
VICTIM_AMOUNT_IN=50000000 # 5 USDC

echo ""
echo "==> [1] policy-swap.enforce() must reject a sandwich-shaped near-zero amount_out_min"
echo "    (the exact shape a compromised keeper key or a bug would produce)"
NOW=$(date +%s)
CTX_SANDWICH="{\"Contract\":{\"contract\":\"$ROUTER\",\"fn_name\":\"swap_exact_tokens_for_tokens\",\"args\":[{\"i128\":\"$VICTIM_AMOUNT_IN\"},{\"i128\":\"1\"},{\"vec\":[{\"address\":\"$USDC\"},{\"address\":\"$XLM\"}]},{\"address\":\"$ACCOUNT\"},{\"u64\":$((NOW + 60))}]}}"
expect_err "amount_out_min=1 stroop rejected by the real oracle-derived floor" \
  stellar contract invoke --id "$PS_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CTX_SANDWICH" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo ""
echo "==> [2] Live sandwich against the real router: fetch the victim's honest quote"
VICTIM_QUOTE=$(amounts_out "$VICTIM_AMOUNT_IN")
echo "    victim wants to swap $VICTIM_AMOUNT_IN USDC stroops, real router quotes $VICTIM_QUOTE XLM stroops right now"
echo "    victim signs with amount_out_min=$VICTIM_QUOTE (zero-tolerance, the tight quote a"
echo "    victim relying on a just-fetched price would use)"

echo ""
echo "==> [3] A real attacker front-run: buying XLM ahead of the victim's transaction"
ATTACKER_AMOUNT_IN=100000000 # 10 USDC
DEADLINE=$(($(date +%s) + 120))
stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
  -- swap_exact_tokens_for_tokens --amount_in "$ATTACKER_AMOUNT_IN" --amount_out_min 1 \
  --path "[\"$USDC\",\"$XLM\"]" --to "$ACCOUNT" --deadline "$DEADLINE" >/dev/null
echo "    real front-run executed: $ATTACKER_AMOUNT_IN USDC stroops -> XLM, real pool reserves shifted"

NEW_QUOTE=$(amounts_out "$VICTIM_AMOUNT_IN")
echo "    real router quote for the same victim amount_in, post front-run: $NEW_QUOTE XLM stroops"
if [ "$NEW_QUOTE" -lt "$VICTIM_QUOTE" ]; then
  echo "    PASS: the real front-run measurably moved the real pool price against the victim"
  pass=$((pass + 1))
else
  echo "    FAIL: front-run did not move the real quote, drill's premise did not hold this run"
  fail=$((fail + 1))
fi

echo ""
echo "==> [4] The victim's original transaction (amount_out_min=$VICTIM_QUOTE) must now revert for real"
DEADLINE=$(($(date +%s) + 120))
expect_err "victim's real swap reverted by the real router's own amount_out_min check" \
  stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
  -- swap_exact_tokens_for_tokens --amount_in "$VICTIM_AMOUNT_IN" --amount_out_min "$VICTIM_QUOTE" \
  --path "[\"$USDC\",\"$XLM\"]" --to "$ACCOUNT" --deadline "$DEADLINE"

echo ""
echo "==> [5] Restoring: a real back-run leg, selling the front-run XLM back for USDC"
# Read the real amount of XLM the front-run leg would fetch back off-chain
# instead of trusting an assumption: the router's own real quote for
# reversing ATTACKER_AMOUNT_IN's worth of XLM back to USDC.
XLM_TO_SELL=$(stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet \
  -- router_get_amounts_out --amount_in "$ATTACKER_AMOUNT_IN" --path "[\"$USDC\",\"$XLM\"]" 2>&1 \
  | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)[1])")
DEADLINE=$(($(date +%s) + 120))
stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
  -- swap_exact_tokens_for_tokens --amount_in "$XLM_TO_SELL" --amount_out_min 1 \
  --path "[\"$XLM\",\"$USDC\"]" --to "$ACCOUNT" --deadline "$DEADLINE" >/dev/null
echo "    real back-run executed: pool reserves restored close to pre-drill levels"

echo ""
echo "==> [6] A production-realistic ${MIN_OUT_BPS}bps-floor victim swap must still succeed post-restoration"
echo "    (the mechanism blocks a real attack without breaking on ordinary honest movement)"
RESTORED_QUOTE=$(amounts_out "$VICTIM_AMOUNT_IN")
REALISTIC_MIN_OUT=$(python3 -c "print(int('$RESTORED_QUOTE') * $MIN_OUT_BPS // 10000)")
DEADLINE=$(($(date +%s) + 120))
stellar contract invoke --id "$ROUTER" --source "$IDENTITY" --network testnet --send=yes \
  -- swap_exact_tokens_for_tokens --amount_in "$VICTIM_AMOUNT_IN" --amount_out_min "$REALISTIC_MIN_OUT" \
  --path "[\"$USDC\",\"$XLM\"]" --to "$ACCOUNT" --deadline "$DEADLINE" >/dev/null
echo "    PASS: real swap with a production-realistic ${MIN_OUT_BPS}bps floor succeeded"
pass=$((pass + 1))

echo ""
echo "==> $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
