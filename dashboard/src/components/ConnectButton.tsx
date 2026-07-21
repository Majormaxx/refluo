"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Wallet, LogOut } from "lucide-react";
import { useFreighter } from "@/hooks/useFreighter";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export function ConnectButton() {
  const { connected, address, connect } = useFreighter();
  const { authenticated, role, address: sessionAddress, loading, signIn, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  async function handleConnectAndSignIn() {
    setBusy(true);
    try {
      const addr = connected && address ? address : await connect();
      await signIn(addr);
      toast.success("Signed in", { description: `Connected as ${role ?? "operator"}` });
    } catch (err) {
      toast.error("Sign-in failed", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOut();
    } catch (err) {
      toast.error("Sign-out failed", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <Skeleton className="h-9 w-40" />;
  }

  if (authenticated && sessionAddress) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="uppercase">
          {role}
        </Badge>
        <code className="text-sm text-muted-foreground">
          {sessionAddress.slice(0, 4)}…{sessionAddress.slice(-4)}
        </code>
        <Button size="sm" variant="outline" onClick={handleSignOut} disabled={busy}>
          <LogOut className="size-3.5" />
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <Button onClick={handleConnectAndSignIn} disabled={busy}>
      <Wallet className="size-4" />
      {busy ? "Signing in…" : "Connect wallet & sign in"}
    </Button>
  );
}
