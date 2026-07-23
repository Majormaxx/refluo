"use client";
import { useEffect, useState } from "react";

const relativeTimeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function formatRelative(fromMs: number, nowMs: number): string {
  const diffSeconds = Math.round((fromMs - nowMs) / 1000);
  if (Math.abs(diffSeconds) < 60) {
    return relativeTimeFormat.format(diffSeconds, "second");
  }
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return relativeTimeFormat.format(diffMinutes, "minute");
  }
  const diffHours = Math.round(diffMinutes / 60);
  return relativeTimeFormat.format(diffHours, "hour");
}

/** "Updated 12s ago" — the answer to "is this actually live or did the
 * poll silently stop succeeding." Ticks its own display once a second;
 * `lastSuccessAtMs` (from useApiResource) is always null until the first
 * client-side fetch completes, so this renders nothing during SSR/
 * hydration, never a stale server-computed timestamp. */
export function FreshnessIndicator({ lastSuccessAtMs }: { lastSuccessAtMs: number | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (lastSuccessAtMs === null) {
    return null;
  }

  return (
    <span className="text-xs text-muted-foreground">
      Updated {formatRelative(lastSuccessAtMs, nowMs)}
    </span>
  );
}
