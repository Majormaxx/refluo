// Pure logic, no network/signing: kept separate from sentinel.ts so it's
// testable without a real RPC connection or a funded keeper key.
import { SystemState } from "risk-engine-client";

/** Blend's Reserve.getUtilization() returns a 7-decimal fixed-point
 * value (SCALAR_7 == 100%). RiskEngine's utilization_bps is basis
 * points (10000 == 100%), 4 decimals. 7 - 4 = 3, so divide by 10^3. */
export function toBps(utilization7Decimal: bigint): number {
  return Number(utilization7Decimal / 1000n);
}

/** Escalation-only, deliberately: recovery is a separate, deliberate
 * keeper decision per adr/0006, never automatic just because
 * utilization dropped back down. Returns null when no call is needed. */
export function decideEscalation(
  utilizationBps: number,
  currentState: SystemState,
  preemptiveUtilBps: number,
  fullDrainUtilBps: number,
): SystemState | null {
  if (utilizationBps >= fullDrainUtilBps && currentState < SystemState.Emergency) {
    return SystemState.Emergency;
  }
  if (utilizationBps >= preemptiveUtilBps && currentState < SystemState.PreemptiveDrain) {
    return SystemState.PreemptiveDrain;
  }
  return null;
}
