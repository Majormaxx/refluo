import { NextRequest, NextResponse } from "next/server";
import { verifyChallengeResponse } from "@/lib/auth/challenge";
import { takeChallenge } from "@/lib/auth/store";
import { resolveDashboardRole } from "@/lib/auth/authorization";
import { issueSessionToken } from "@/lib/auth/session";
import { requireEnv } from "@/lib/env";
import { withErrorHandling } from "@/lib/apiError";

export async function POST(req: NextRequest) {
  return withErrorHandling(async () => {
    const body = (await req.json().catch(() => null)) as {
      nonce?: string;
      address?: string;
      signedMessage?: string;
    } | null;
    if (!body?.nonce || !body.address || !body.signedMessage) {
      return NextResponse.json(
        { error: "nonce, address, and signedMessage are required", retryable: false },
        { status: 400 },
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const challenge = takeChallenge(body.nonce, nowSeconds);
    if (!challenge || challenge.address !== body.address) {
      return NextResponse.json(
        { error: "unknown or expired challenge, request a new one", retryable: false },
        { status: 401 },
      );
    }

    const signature = Buffer.from(body.signedMessage, "base64");
    if (!verifyChallengeResponse(challenge, signature, nowSeconds)) {
      return NextResponse.json({ error: "invalid signature", retryable: false }, { status: 401 });
    }

    // The one real network call in this route: resolveDashboardRole
    // simulates against the real vault/health-monitor contracts, so a
    // transient RPC failure here is real and retryable, not a genuine
    // authorization rejection — withErrorHandling classifies it as such
    // rather than this route conflating it with "not an admin/guardian".
    const role = await resolveDashboardRole(body.address);
    if (!role) {
      return NextResponse.json(
        {
          error: "address is not a current admin or guardian on this vault",
          retryable: false,
        },
        { status: 403 },
      );
    }

    const token = issueSessionToken(
      { address: body.address, role, issuedAtSeconds: nowSeconds },
      requireEnv("SESSION_SECRET"),
    );

    const response = NextResponse.json({ address: body.address, role });
    response.cookies.set("refluo_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 3600,
      path: "/",
    });
    return response;
  });
}
