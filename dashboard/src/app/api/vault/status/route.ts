import { NextResponse } from "next/server";
import { fetchVaultStatus } from "@/lib/contracts/vaultOverview";
import { requireSession } from "@/lib/auth/getSession";
import { withErrorHandling } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    await requireSession();
    const status = await fetchVaultStatus();
    return NextResponse.json(status);
  });
}
