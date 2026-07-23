// Pure event-replay logic for the "Incidents" page, split out from
// pauseHistory.ts's real I/O (which imports "server-only" transitively via
// ../stellar) so this stays directly unit-testable — no RPC client
// construction, no side effects at module load, matching the same split
// riskProfile.ts/vaultOverview.ts and systemState.ts/vaultOverview.ts
// already use in this directory.
//
// Real finding driving this state machine (adr/0022): HealthMonitor's
// pause() has no guard against being called again while already paused —
// it unconditionally overwrites the whole PauseState (trigger/
// extensions_used/expiry all reset). Naive "each Paused pairs with the
// next chronological Resumed" is unsafe: a second real Paused event can
// land before any Resumed. This replays every event in chronological
// order as a small state machine instead of pairing by index.

export type PauseResolution = "resumed_early" | "auto_expired" | "superseded" | "active";

export interface PauseExtensionRecord {
  atSeconds: number;
  extensionsUsed: number;
  pauseExpirySeconds: number;
}

export interface PauseEpisode {
  pausedAtSeconds: number;
  trigger: string;
  extensions: PauseExtensionRecord[];
  resolution: PauseResolution;
  resolvedAtSeconds: number | null;
  finalPauseExpirySeconds: number;
}

export interface RawPauseEvent {
  type: "paused";
  atSeconds: number;
  trigger: string;
  pauseExpirySeconds: number;
}
export interface RawExtendedEvent {
  type: "extended";
  atSeconds: number;
  extensionsUsed: number;
  pauseExpirySeconds: number;
}
export interface RawResumedEvent {
  type: "resumed";
  atSeconds: number;
}
export type RawEvent = RawPauseEvent | RawExtendedEvent | RawResumedEvent;

/** Pure replay of real, chronologically-sorted events into episodes.
 * `nowSeconds` only matters for classifying whatever episode is still
 * open at the end of the list (auto-expired vs. genuinely still active). */
export function reconstructPauseHistory(events: RawEvent[], nowSeconds: number): PauseEpisode[] {
  const episodes: PauseEpisode[] = [];
  let open: PauseEpisode | null = null;

  for (const event of events) {
    if (event.type === "paused") {
      if (open) {
        // A real re-trigger while already paused (pause() has no guard
        // against this). If the prior episode's own expiry had already
        // passed by the time this new Paused landed, it genuinely
        // auto-expired first; otherwise this new Paused really did cut
        // it short.
        open.resolution = open.finalPauseExpirySeconds <= event.atSeconds ? "auto_expired" : "superseded";
        open.resolvedAtSeconds =
          open.resolution === "auto_expired" ? open.finalPauseExpirySeconds : event.atSeconds;
      }
      open = {
        pausedAtSeconds: event.atSeconds,
        trigger: event.trigger,
        extensions: [],
        resolution: "active",
        resolvedAtSeconds: null,
        finalPauseExpirySeconds: event.pauseExpirySeconds,
      };
      episodes.push(open);
    } else if (event.type === "extended") {
      if (open) {
        open.extensions.push({
          atSeconds: event.atSeconds,
          extensionsUsed: event.extensionsUsed,
          pauseExpirySeconds: event.pauseExpirySeconds,
        });
        open.finalPauseExpirySeconds = event.pauseExpirySeconds;
      }
    } else {
      // resumed
      if (open) {
        open.resolution = "resumed_early";
        open.resolvedAtSeconds = event.atSeconds;
        open = null;
      }
    }
  }

  if (open && open.finalPauseExpirySeconds <= nowSeconds) {
    open.resolution = "auto_expired";
    open.resolvedAtSeconds = open.finalPauseExpirySeconds;
  }

  return episodes.reverse(); // most recent first, for display
}
