"use client";
// Component-level error boundary for one dashboard panel, using Next
// 16.2's own unstable_catchError (not a hand-rolled class component):
// a render-time crash in one panel (a null-deref on an unexpected data
// shape, for example) shows a real fallback card instead of blanking
// the whole dashboard, and every other panel keeps working.
import { unstable_catchError, type ErrorInfo } from "next/error";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function PanelErrorFallback(props: { title: string }, { error, unstable_retry }: ErrorInfo) {
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="size-4" />
          {props.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button size="sm" variant="outline" onClick={() => unstable_retry()}>
          <RotateCw className="size-3.5" />
          Reload panel
        </Button>
      </CardContent>
    </Card>
  );
}

export const PanelErrorBoundary = unstable_catchError(PanelErrorFallback);
