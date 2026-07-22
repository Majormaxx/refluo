// Server-only real Stellar/contract configuration. Every contract id here
// names the same deployment this dashboard is meant to operate: one
// dashboard instance per vault, matching the auth model (admin/guardian
// addresses are looked up against this specific vault's own on-chain
// state, not a multi-tenant registry).
import "server-only";
import { rpc } from "@stellar/stellar-sdk";
import { requireEnv, optionalEnv } from "./env";

export const RPC_URL = optionalEnv("RPC_URL", "https://soroban-testnet.stellar.org");
export const NETWORK_PASSPHRASE = optionalEnv(
  "NETWORK_PASSPHRASE",
  "Test SDF Network ; September 2015",
);

export const VAULT_ADDRESS = requireEnv("VAULT_ADDRESS");
export const RISK_ENGINE_ID = requireEnv("RISK_ENGINE_ID");
// The plain identity (never the vault contract itself) RiskEngine's own
// `account` parameter tracks state under, matching keeper/.env.example's
// established ACCOUNT convention: RiskEngine.init() calls
// `account.require_auth()`, so this has to be an address that can
// self-authorize directly, not a CustomAccountInterface vault requiring
// the SDK's own multi-party signing module (adr/0016) just to read state.
export const RISK_ENGINE_ACCOUNT = requireEnv("RISK_ENGINE_ACCOUNT");
export const HEALTH_MONITOR_ID = requireEnv("HEALTH_MONITOR_ID");
export const TIMELOCK_ID = requireEnv("TIMELOCK_ID");
export const USDC_TOKEN_ID = requireEnv("USDC_TOKEN_ID");
export const XLM_TOKEN_ID = requireEnv("XLM_TOKEN_ID");

export const server = new rpc.Server(RPC_URL);
