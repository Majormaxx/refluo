"use client";
import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

/** True only once mounted on the real client, false during SSR/the first
 * hydration pass — via useSyncExternalStore's dedicated server snapshot,
 * not a setState-in-effect mounted flag (react-hooks/set-state-in-effect
 * flags that pattern, and this is the documented replacement). */
function useIsClient(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // next-themes resolves the real system preference only after mount;
  // rendering a fixed icon before that would flash the wrong one.
  const mounted = useIsClient();

  if (!mounted) {
    return <Button size="icon" variant="ghost" disabled className="size-9" />;
  }

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-9"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
