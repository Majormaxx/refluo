"use client";
// global-error replaces the root layout entirely when it fires, so it
// must define its own <html>/<body> and can't assume the layout's own
// fonts or providers ran (Next's own docs, app/api-reference/file-
// conventions/error#global-error). Kept minimal and self-contained.
import "./globals.css";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-md space-y-4 rounded-lg border p-6 text-center">
          <h2 className="text-lg font-semibold">The dashboard crashed</h2>
          <p className="text-sm text-muted-foreground">
            {error.digest ? `Reference: ${error.digest}` : error.message}
          </p>
          <button
            onClick={() => unstable_retry()}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
