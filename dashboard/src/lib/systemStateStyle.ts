import { ShieldAlert, CircleCheck, TriangleAlert, Ban, CircleHelp } from "lucide-react";
import type { SystemState } from "dashboard-risk-engine-client";

interface SystemStateStyle {
  label: string;
  badgeClassName: string;
  icon: typeof CircleCheck;
  /** Shown on hover: every SystemState value here reflects RiskEngine's
   * own stored state as of its last check_and_trip()/keeper_advance_state()
   * call (contracts/risk-engine/src/lib.rs:290-307), not a live read —
   * it can lag a real-time HealthMonitor guardian pause until that crank
   * runs again. */
  description: string;
}

const STALENESS_NOTE =
  "Reflects RiskEngine's own state as of its last check_and_trip()/keeper_advance_state() call — not necessarily live.";

export const SYSTEM_STATE_STYLE: Record<keyof typeof SystemState, SystemStateStyle> = {
  Normal: {
    label: "Normal",
    badgeClassName: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    icon: CircleCheck,
    description: STALENESS_NOTE,
  },
  PreemptiveDrain: {
    label: "Preemptive drain",
    badgeClassName: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    icon: TriangleAlert,
    description: STALENESS_NOTE,
  },
  Emergency: {
    label: "Emergency",
    badgeClassName: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    icon: ShieldAlert,
    description: STALENESS_NOTE,
  },
  Paused: {
    // "Risk engine paused", not just "Paused": StatusBar shows a separate
    // guardian-pause badge sourced from a different contract
    // (HealthMonitor.status(), always live) — this label and icon are
    // deliberately distinct from that one (PauseCircle), even though both
    // ultimately trace back to the same real guardian pause, so the two
    // independent signals never look like a single duplicated one.
    label: "Risk engine paused",
    badgeClassName: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    icon: Ban,
    description: STALENESS_NOTE,
  },
};

/** Defensive fallback for a `SystemState` value this record doesn't
 * recognize. `vaultOverview.ts`'s `decodeSystemState` already throws at
 * the fetch boundary for this case (the primary defense, giving a real
 * diagnosable error); this is a second, independent safety net for any
 * other path that might hand a component a state value. */
export const UNKNOWN_SYSTEM_STATE_STYLE: SystemStateStyle = {
  label: "Unknown state",
  badgeClassName: "bg-muted text-muted-foreground",
  icon: CircleHelp,
  description: "This system state value wasn't recognized.",
};
