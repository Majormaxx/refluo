import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/getSession";
import { withErrorHandling } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ authenticated: false });
    }
    return NextResponse.json({ authenticated: true, address: session.address, role: session.role });
  });
}

export async function DELETE() {
  return withErrorHandling(async () => {
    const response = NextResponse.json({ ok: true });
    response.cookies.delete("refluo_session");
    return response;
  });
}
