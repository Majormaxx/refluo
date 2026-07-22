// Browser-safe configuration: contract ids and network params are public
// addresses, not secrets, safe to bundle into client code (unlike
// stellar.ts's SESSION_SECRET-adjacent server config, which stays
// server-only). NEXT_PUBLIC_-prefixed so Next.js inlines these at build
// time for client components.
export const PUBLIC_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const PUBLIC_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
export const PUBLIC_VAULT_ADDRESS = process.env.NEXT_PUBLIC_VAULT_ADDRESS ?? "";
export const PUBLIC_HEALTH_MONITOR_ID = process.env.NEXT_PUBLIC_HEALTH_MONITOR_ID ?? "";
export const PUBLIC_TIMELOCK_ID = process.env.NEXT_PUBLIC_TIMELOCK_ID ?? "";
