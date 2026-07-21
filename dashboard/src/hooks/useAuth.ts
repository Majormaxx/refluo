"use client";
import { useCallback, useEffect, useState } from "react";
import { signMessage } from "@stellar/freighter-api";
import { fetchJson } from "@/lib/apiClient";
import { describeFreighterApiError } from "@/lib/actions/actionError";

export interface AuthState {
  authenticated: boolean;
  address: string | null;
  role: "admin" | "guardian" | null;
}

interface SessionResponse {
  authenticated: boolean;
  address?: string;
  role?: "admin" | "guardian";
}

export function useAuth() {
  const [auth, setAuth] = useState<AuthState>({
    authenticated: false,
    address: null,
    role: null,
  });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // A failed session check fails closed to "not authenticated" rather
    // than blocking the UI: a transient RPC/network blip here should
    // never look like a successful, privileged sign-in.
    try {
      const data = await fetchJson<SessionResponse>("/api/auth/session");
      setAuth({
        authenticated: !!data.authenticated,
        address: data.address ?? null,
        role: data.role ?? null,
      });
    } catch {
      setAuth({ authenticated: false, address: null, role: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const data = await fetchJson<SessionResponse>("/api/auth/session");
        if (ignore) return;
        setAuth({
          authenticated: !!data.authenticated,
          address: data.address ?? null,
          role: data.role ?? null,
        });
      } catch {
        if (!ignore) {
          setAuth({ authenticated: false, address: null, role: null });
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, []);

  /** Real SEP-53 challenge/response sign-in: request a challenge tied to
   * `address`, sign it with the real connected wallet, verify server-side
   * against real on-chain admin/guardian membership (PRD 8.2's own auth
   * model — no separate identity system). Throws an Error with a
   * human-readable message on any failure (wallet rejection, expired
   * challenge, not a real admin/guardian, transient network issue); the
   * caller (ConnectButton) is responsible for presenting it. */
  const signIn = useCallback(
    async (address: string) => {
      const { nonce, message } = await fetchJson<{ nonce: string; message: string }>(
        "/api/auth/challenge",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        },
      );

      const signResult = await signMessage(message, { address });
      if (signResult.error) {
        const { description } = describeFreighterApiError(signResult.error);
        throw new Error(description);
      }
      if (!signResult.signedMessage) {
        throw new Error("wallet returned no signature");
      }
      const signedMessage =
        typeof signResult.signedMessage === "string"
          ? signResult.signedMessage
          : Buffer.from(signResult.signedMessage).toString("base64");

      await fetchJson("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce, address, signedMessage }),
      });
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    await fetchJson("/api/auth/session", { method: "DELETE" });
    await refresh();
  }, [refresh]);

  return { ...auth, loading, signIn, signOut, refresh };
}
