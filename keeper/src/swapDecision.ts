// Pure logic, no network/signing: same separation decision.ts uses, kept
// testable without a real RPC connection or a funded keeper key.
//
// Mirrors policy-swap's own on-chain oracle-derived-floor formula exactly
// (contracts/policy-swap/src/lib.rs, oracle_derived_min_out), so the
// amount_out_min this loop proposes is never looser than what the
// contract itself will accept. Both USDC and XLM are real 7-decimal SAC
// tokens on Stellar testnet (verified live, not assumed), so those
// decimal factors cancel here the same way they do on-chain.

export interface SwapNeed {
  amountInUsdcStroops: bigint;
  amountOutMinXlmStroops: bigint;
}

const PRICE_SCALE = 10n ** 14n; // matches OracleRouter's real ROUTER_DECIMALS
const BPS_DENOM = 10_000n;

/** Oracle-fair XLM output for a given USDC input, same formula the
 * on-chain contract computes independently and will re-check. */
export function oracleDerivedMinOut(
  amountInUsdcStroops: bigint,
  xlmPrice14Decimals: bigint,
  minOutBps: number,
): bigint {
  if (xlmPrice14Decimals <= 0n) {
    throw new Error("oracle price must be positive");
  }
  const expectedOut = (amountInUsdcStroops * PRICE_SCALE) / xlmPrice14Decimals;
  return (expectedOut * BigInt(minOutBps)) / BPS_DENOM;
}

/** Escalation-only in the same sense decideEscalation is: this only ever
 * proposes a top-up swap when the real XLM balance has fallen below the
 * configured floor. Returns null when no swap is needed. */
export function decideSwap(
  xlmBalanceStroops: bigint,
  xlmFloorStroops: bigint,
  xlmTopupTargetStroops: bigint,
  xlmPrice14Decimals: bigint,
  minOutBps: number,
): SwapNeed | null {
  if (xlmTopupTargetStroops <= xlmFloorStroops) {
    throw new Error("xlmTopupTarget must be strictly above xlmFloor");
  }
  if (xlmBalanceStroops >= xlmFloorStroops) {
    return null;
  }

  const shortfall = xlmTopupTargetStroops - xlmBalanceStroops;
  const amountInUsdcStroops = (shortfall * xlmPrice14Decimals) / PRICE_SCALE;
  const amountOutMinXlmStroops = oracleDerivedMinOut(
    amountInUsdcStroops,
    xlmPrice14Decimals,
    minOutBps,
  );

  return { amountInUsdcStroops, amountOutMinXlmStroops };
}
