import { NextResponse } from "next/server";
import { fetchVaultOverview } from "@/lib/contracts/vaultOverview";
import { requireSession } from "@/lib/auth/getSession";
import { withErrorHandling } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    await requireSession();
    const overview = await fetchVaultOverview();
    return NextResponse.json(overview);
  });
}
