// Decodes RiskEngine's real SystemState enum value defensively, in one
// place, rather than casting inline at every call site. `SystemState` is
// a plain numeric enum (dashboard-risk-engine-client); reverse-mapping an
// unrecognized number produces `undefined` silently unless checked here —
// a future 5th contract state (or any decode bug) should fail loud, at
// the boundary where it's diagnosable, not deep inside a component render.
import { SystemState } from "dashboard-risk-engine-client";

const KNOWN_KEYS = new Set(["Normal", "PreemptiveDrain", "Emergency", "Paused"]);

/** A plain enum object import — no RPC client construction, no side
 * effects at module load, unlike vaultOverview.ts. Safe to import
 * directly in a unit test. */
export function decodeSystemState(raw: SystemState): keyof typeof SystemState {
  const decoded = SystemState[raw];
  if (typeof decoded !== "string" || !KNOWN_KEYS.has(decoded)) {
    throw new Error(`RiskEngine returned an unrecognized SystemState value: ${raw}`);
  }
  return decoded as keyof typeof SystemState;
}
