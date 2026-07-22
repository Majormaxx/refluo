import { ShieldAlert, CircleCheck, TriangleAlert, PauseCircle } from "lucide-react";
import type { SystemState } from "dashboard-risk-engine-client";

export const SYSTEM_STATE_STYLE: Record<
  keyof typeof SystemState,
  { label: string; badgeClassName: string; icon: typeof CircleCheck }
> = {
  Normal: {
    label: "Normal",
    badgeClassName: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    icon: CircleCheck,
  },
  PreemptiveDrain: {
    label: "Preemptive drain",
    badgeClassName: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    icon: TriangleAlert,
  },
  Emergency: {
    label: "Emergency",
    badgeClassName: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    icon: ShieldAlert,
  },
  Paused: {
    label: "Paused",
    badgeClassName: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    icon: PauseCircle,
  },
};
