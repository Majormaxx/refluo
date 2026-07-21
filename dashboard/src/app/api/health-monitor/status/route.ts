import { NextResponse } from "next/server";
import { fetchGuardianPanelData } from "@/lib/contracts/healthMonitor";
import { requireSession } from "@/lib/auth/getSession";
import { withErrorHandling } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    await requireSession();
    const data = await fetchGuardianPanelData();
    return NextResponse.json(data);
  });
}
