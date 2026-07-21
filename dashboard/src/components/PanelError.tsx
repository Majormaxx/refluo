"use client";
import { AlertTriangle, WifiOff, RotateCw } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApiClientError } from "@/lib/apiClient";

/** Shared error state for a panel's data fetch. A retryable error (a
 * transient RPC/network blip, classified server-side by lib/apiError.ts
 * or client-side by lib/apiClient.ts) gets a distinct icon/copy from a
 * permanent one, and always offers the same real retry affordance. */
export function PanelError({ error, onRetry }: { error: ApiClientError; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      {error.retryable ? <WifiOff className="size-4" /> : <AlertTriangle className="size-4" />}
      <AlertTitle>{error.retryable ? "Temporary network issue" : "Request failed"}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{error.message}</span>
        <Button size="sm" variant="outline" onClick={onRetry} className="w-fit">
          <RotateCw className="size-3.5" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
