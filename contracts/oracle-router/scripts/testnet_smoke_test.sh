#!/usr/bin/env bash
# Live end-to-end verification against real testnet oracle infrastructure —
# not mocks. Deploys OracleRouter to Stellar testnet, configures it against
# Reflector Pulse and RedStone's real testnet feeds (addresses verified from
# each provider's own source, see refluo-prd-unified.md §13, local), and
# confirms get_price() returns a Healthy quote both feeds agree on.
#
# Requires: stellar-cli, a funded testnet identity. Create one with:
#   stellar keys generate refluo-testnet --network testnet --fund
set -euo pipefail

cd "$(dirname "$0")/../../.."

IDENTITY="${1:-refluo-testnet}"

echo "==> Building oracle-router wasm"
stellar contract build --package refluo-oracle-router

echo "==> Deploying to testnet"
ORACLE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/refluo_oracle_router.wasm \
  --source "$IDENTITY" \
  --network testnet 2>&1 | tail -1)
echo "    deployed at $ORACLE_ID"

# Reflector Pulse testnet (base USD, generic-symbol assets) — live-verified
# by direct call, not officially documented by Reflector. RedStone SEP-40
# testnet — verified from redstone-finance/redstone-oracles-monorepo,
# packages/stellar-connector/stellar/redstone_sep_40-id.testnet.
REFLECTOR_TESTNET=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
REDSTONE_SEP40_TESTNET=CA7MY6TYNL5Z5H5FYGMN7YWSY3JIZG7LFY3DZ26EEGRBQ2UKTFWHD4ZJ
# XLM native SAC on testnet, RedStone's own asset key for it (confirmed via
# a live assets() call against REDSTONE_SEP40_TESTNET).
XLM_SAC_TESTNET=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC

echo "==> Configuring XLM: primary=Reflector (Other(XLM)), secondary=RedStone (Stellar(SAC))"
echo "    Per-feed asset keys differ for the same logical asset — confirmed live,"
echo "    not an assumption. See the config's doc comment in src/lib.rs."
stellar contract invoke \
  --id "$ORACLE_ID" \
  --source "$IDENTITY" \
  --network testnet \
  -- set_config \
  --asset '{"Other":"XLM"}' \
  --cfg "{
    \"primary_feed\": \"$REFLECTOR_TESTNET\",
    \"primary_asset\": {\"Other\":\"XLM\"},
    \"secondary_feed\": \"$REDSTONE_SEP40_TESTNET\",
    \"secondary_asset\": {\"Stellar\":\"$XLM_SAC_TESTNET\"},
    \"max_staleness_primary\": 600,
    \"max_staleness_secondary\": 90000,
    \"twap_periods\": 6,
    \"divergence_soft\": 200,
    \"divergence_hard\": 500,
    \"max_roc_per_update\": 1000
  }"

echo "==> Reading live price"
RESULT=$(stellar contract invoke \
  --id "$ORACLE_ID" \
  --source "$IDENTITY" \
  --network testnet \
  --send=yes \
  -- get_price --asset '{"Other":"XLM"}' 2>&1 | tail -1)
echo "    $RESULT"

if echo "$RESULT" | grep -q '"status":0'; then
  echo "==> PASS: status Healthy, both real feeds agreed within the soft divergence band"
else
  echo "==> FAIL: expected status 0 (Healthy). Feed data may have changed since this"
  echo "    script was last run — check the raw quote above before assuming a bug."
  exit 1
fi
