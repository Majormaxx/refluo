import "server-only";

// The public testnet RPC intermittently times out or drops a connection
// under load; every other real-infrastructure-touching part of this
// workspace already retries around that (sdk/src/smartAccountAuth.ts,
// keeper/src/forecasterLoop.ts), and this dashboard's own server-side
// reads are no different: an uncaught transient timeout here surfaces to
// a real operator as a 500, not a legitimate on-chain rejection.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}
