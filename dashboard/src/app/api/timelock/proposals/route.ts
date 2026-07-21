import { NextResponse } from "next/server";
import { fetchPendingProposals } from "@/lib/contracts/timelockProposals";
import { withErrorHandling } from "@/lib/apiError";

// Deliberately no auth check: "anyone can view (watcher transparency)"
// is the spec's own wording (PRD 8.2) for this specific panel, unlike
// the others. Only cancel (a state-changing action) is admin-gated.
export async function GET() {
  return withErrorHandling(async () => {
    const proposals = await fetchPendingProposals();
    return NextResponse.json({ proposals });
  });
}
