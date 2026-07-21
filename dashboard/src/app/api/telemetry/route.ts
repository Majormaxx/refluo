import { NextResponse } from "next/server";
import { readSlaSnapshot } from "@/lib/telemetry";
import { requireSession } from "@/lib/auth/getSession";
import { withErrorHandling } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    await requireSession();
    const snapshot = readSlaSnapshot();
    if (!snapshot) {
      return NextResponse.json({
        snapshot: null,
        message: "reporter has not produced a snapshot yet",
      });
    }
    return NextResponse.json({ snapshot });
  });
}
