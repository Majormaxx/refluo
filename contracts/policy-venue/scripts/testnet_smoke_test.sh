#!/usr/bin/env bash
# Live end-to-end verification against a real, live Blend V2 testnet pool
# (blend-capital/blend-utils testnet.contracts.json, poolFactoryV2's own
# TestnetV2 pool), not a calldata-shape assumption. Two real halves:
# policy-venue's own enforce() gates a Blend-shaped submit() call
# correctly (allowed Supply within cap, rejected Borrow, rejected
# over-cap), then a real submit() call actually round-trips through the
# real deployed pool with real XLM, confirmed via a real position read
# back from the pool afterward. See adr/0012.
#
# smart_account in these enforce() calls is this script's own funded
# identity, not a deployed vault: enforce() only needs
# smart_account.require_auth(), which a plain EOA satisfies the same way
# a CustomAccountInterface vault would once the SDK's signing module
# exists (adr/0008). What's proven here is policy-venue's real decode and
# gating logic against a real pool's real calldata shape, not the vault
# authorization chain, which is already covered separately.
#
# Requires: stellar-cli, a funded testnet identity. Create one with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/../../.."

IDENTITY="${1:-refluo-testnet}"
ACCOUNT=$(stellar keys address "$IDENTITY")

# Real Blend V2 testnet pool, from blend-capital/blend-utils'
# testnet.contracts.json (poolFactoryV2's TestnetV2 instance), verified
# live: get_reserve_list returns real XLM/wETH/wBTC/USDC reserves,
# get_config returns a real Active pool.
BLEND_POOL=CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF
XLM_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

echo "==> Building policy-venue"
stellar contract build --package refluo-policy-venue

echo "==> Deploying policy-venue"
PV_ID=$(stellar contract deploy --wasm target/wasm32v1-none/release/refluo_policy_venue.wasm \
  --source "$IDENTITY" --network testnet 2>&1 | tail -1)
echo "    deployed at $PV_ID"

echo "==> Installing config: venue=real Blend pool, per_call_cap=50 XLM"
stellar contract invoke --id "$PV_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- install --install_params "{
    \"venues\": [\"$BLEND_POOL\"], \"per_call_cap\": \"500000000\",
    \"epoch_cap\": \"5000000000\", \"epoch_length\": 86400
  }" --context_rule "{
    \"id\": 1, \"context_type\": \"Default\", \"name\": \"r_yield\",
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
  if "$@" >/tmp/pv_smoke_err 2>&1; then
    echo "    FAIL: $desc (expected rejection, call succeeded)"
    fail=$((fail + 1))
  else
    echo "    PASS: $desc (rejected as expected)"
    pass=$((pass + 1))
  fi
}

RULE='{"id": 1, "context_type": "Default", "name": "r_yield", "signers": [], "signer_ids": [], "policies": [], "policy_ids": [], "valid_until": null}'

# A Blend Request is a struct with named fields address/amount/request_type;
# Soroban's ScMap JSON form is an array of {key, val} pairs, key-sorted,
# not a plain JSON object. Found by trial against the real deployed
# contract, not assumed from docs.
blend_request() {
  local amount="$1" request_type="$2"
  echo "{\"map\":[{\"key\":{\"symbol\":\"address\"},\"val\":{\"address\":\"$XLM_ID\"}},{\"key\":{\"symbol\":\"amount\"},\"val\":{\"i128\":\"$amount\"}},{\"key\":{\"symbol\":\"request_type\"},\"val\":{\"u32\":$request_type}}]}"
}
submit_context() {
  local request="$1"
  echo "{\"Contract\":{\"contract\":\"$BLEND_POOL\",\"fn_name\":\"submit\",\"args\":[{\"address\":\"$ACCOUNT\"},{\"address\":\"$ACCOUNT\"},{\"address\":\"$ACCOUNT\"},{\"vec\":[$request]}]}}"
}
CONTEXT_SUPPLY=$(submit_context "$(blend_request 100000000 0)")
CONTEXT_BORROW=$(submit_context "$(blend_request 1 4)")
CONTEXT_OVER_CAP=$(submit_context "$(blend_request 999999999999 0)")

echo "==> [1] policy-venue must allow a real Blend Supply(XLM) request within cap"
stellar contract invoke --id "$PV_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CONTEXT_SUPPLY" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT" >/dev/null
echo "    PASS: real Supply(XLM, request_type=0) request allowed"
pass=$((pass + 1))

echo "==> [2] policy-venue must reject a real Blend Borrow request"
expect_err "Borrow (request_type=4) rejected, matches Blend's real enum, not a guess" \
  stellar contract invoke --id "$PV_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CONTEXT_BORROW" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo "==> [3] policy-venue must reject a Supply over per_call_cap"
expect_err "Supply amount over per_call_cap rejected" \
  stellar contract invoke --id "$PV_ID" --source "$IDENTITY" --network testnet --send=yes \
  -- enforce --context "$CONTEXT_OVER_CAP" \
  --authenticated_signers "[{\"Delegated\":\"$ACCOUNT\"}]" \
  --context_rule "$RULE" --smart_account "$ACCOUNT"

echo "==> [4] A real submit() call must actually round-trip through the real Blend pool"
BEFORE=$(stellar contract invoke --id "$BLEND_POOL" --source "$IDENTITY" --network testnet \
  -- get_positions --address "$ACCOUNT" 2>&1 | tail -1)
stellar contract invoke --id "$BLEND_POOL" --source "$IDENTITY" --network testnet --send=yes \
  -- submit --from "$ACCOUNT" --spender "$ACCOUNT" --to "$ACCOUNT" \
  --requests "[{\"address\":\"$XLM_ID\",\"amount\":\"10000000\",\"request_type\":0}]" >/dev/null
AFTER=$(stellar contract invoke --id "$BLEND_POOL" --source "$IDENTITY" --network testnet \
  -- get_positions --address "$ACCOUNT" 2>&1 | tail -1)
if [ "$BEFORE" != "$AFTER" ]; then
  echo "    PASS: a real 1 XLM supply changed the real pool's recorded position"
  pass=$((pass + 1))
else
  echo "    FAIL: real submit() call did not change the real pool's position"
  fail=$((fail + 1))
fi

echo ""
echo "==> $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
