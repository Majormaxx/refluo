"use client";
import { useState } from "react";

export interface AnimateOnceOnMount {
  /** Pass to `isAnimationActive` on the chart's primary series. */
  shouldAnimate: boolean;
  /** Pass to that same series' `onAnimationEnd` — a real event callback,
   * not an effect, so setting state here never trips
   * `react-hooks/set-state-in-effect`. Locks animation off the moment the
   * real first-mount entrance animation actually finishes, rather than
   * guessing a timeout. */
  handleAnimationEnd: () => void;
}

/** Animates in once on mount, then stays off for every subsequent
 * poll-driven data update — Recharts' default replays a full
 * grow-from-zero animation on *every* data change, which would make a
 * live-polled chart flicker/redraw every 15-30s instead of reading as a
 * value settling in once.
 *
 * This project's stricter hook lint rules rule out both of the usual
 * approaches: reading a `useRef` mount flag during render
 * (`react-hooks/refs` disallows accessing `.current` during render) and
 * flipping a `useState` flag inside a `useEffect`
 * (`react-hooks/set-state-in-effect` disallows synchronous setState in
 * an effect body). Driving the flag from Recharts' own real
 * `onAnimationEnd` callback sidesteps both: it's a plain event-callback
 * setState, not a render-phase ref read or an effect body. */
export function useAnimateOnceOnMount(): AnimateOnceOnMount {
  const [shouldAnimate, setShouldAnimate] = useState(true);

  return {
    shouldAnimate,
    handleAnimationEnd: () => setShouldAnimate(false),
  };
}
