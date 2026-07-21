"use client";
import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-6">
      <Card className="w-full border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-5" />
            Something went wrong
          </CardTitle>
          <CardDescription>
            {error.digest ? `Reference: ${error.digest}` : error.message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => unstable_retry()}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
