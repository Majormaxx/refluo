"use client";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { SYSTEM_STATE_STYLE, UNKNOWN_SYSTEM_STATE_STYLE } from "@/lib/systemStateStyle";
import type { SystemState } from "dashboard-risk-engine-client";

export function SystemStateBadge({ state }: { state: keyof typeof SystemState }) {
  const style = SYSTEM_STATE_STYLE[state] ?? UNKNOWN_SYSTEM_STATE_STYLE;
  const Icon = style.icon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className={cn(
          "flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
          style.badgeClassName,
        )}
      >
        <Icon className="size-3.5" />
        {style.label}
      </TooltipTrigger>
      <TooltipContent>{style.description}</TooltipContent>
    </Tooltip>
  );
}
