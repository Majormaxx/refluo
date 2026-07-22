"use client";
// Shared data-fetching hook every panel uses instead of its own
// duplicated fetch+loading+error boilerplate. Exposes a typed
// ApiClientError (lib/apiClient.ts) and a reload() a panel wires to a
// "Retry" button, so every panel gets the same real recovery path for
// the RPC flakiness this workspace has repeatedly documented.
//
// `loading` is derived by comparing a generation key (url + reload
// count) against the key of the last fetch that actually completed,
// rather than a separate boolean flipped synchronously inside the
// effect: every setState call here happens strictly after the real
// `await fetchJson(...)` settles, never in the effect's own synchronous
// prefix, matching React's own current guidance against triggering a
// cascading render from an effect body (react-hooks/set-state-in-effect).
import { useCallback, useEffect, useState } from "react";
import { fetchJson, ApiClientError } from "@/lib/apiClient";

export interface ApiResourceState<T> {
  data: T | null;
  error: ApiClientError | null;
  /** True only for the first fetch (no data yet). A background poll or a
   * manual reload() while data from a prior successful fetch is already
   * on screen never re-triggers the full loading/skeleton state — the
   * existing data stays visible, `refreshing` is the signal for that. */
  loading: boolean;
  /** True whenever any fetch (initial, polled, or manual reload) is in
   * flight, including ones that don't flip `loading`. Panels that want a
   * subtle "updating" indicator during a background refresh use this;
   * panels that don't care can ignore it. */
  refreshing: boolean;
  reload: () => void;
}

export function useApiResource<T>(
  url: string | null,
  options?: { pollIntervalMs?: number },
): ApiResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const key = url ? `${url}#${reloadToken}` : null;

  useEffect(() => {
    if (!key || !url) {
      return;
    }
    let ignore = false;
    (async () => {
      try {
        const result = await fetchJson<T>(url);
        if (!ignore) {
          setData(result);
          setError(null);
          setCompletedKey(key);
        }
      } catch (err) {
        if (!ignore) {
          setError(
            err instanceof ApiClientError ? err : new ApiClientError(String(err), 0, false),
          );
          setCompletedKey(key);
        }
      }
    })();
    return () => {
      ignore = true;
    };
  }, [key, url]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const pollIntervalMs = options?.pollIntervalMs;
  useEffect(() => {
    if (!url || !pollIntervalMs) {
      return;
    }
    const interval = setInterval(reload, pollIntervalMs);
    return () => clearInterval(interval);
  }, [url, pollIntervalMs, reload]);

  const refreshing = !!key && completedKey !== key;

  return { data, error, loading: refreshing && data === null, refreshing, reload };
}
