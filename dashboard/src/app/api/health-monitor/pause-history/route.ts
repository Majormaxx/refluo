import { NextResponse } from "next/server";
import { fetchPauseHistory } from "@/lib/contracts/pauseHistory";
import { withErrorHandling } from "@/lib/apiError";

// Deliberately no auth check, same rationale as the timelock queue (PRD
// 8.2's "anyone can view" watcher-transparency wording): past pause
// episodes are exactly the same kind of public, on-chain-derived history.
export async function GET() {
  return withErrorHandling(async () => {
    const episodes = await fetchPauseHistory();
    return NextResponse.json({ episodes });
  });
}
