import { NextRequest, NextResponse } from "next/server";
import { createChallenge, challengeMessage } from "@/lib/auth/challenge";
import { putChallenge, pruneExpiredChallenges } from "@/lib/auth/store";
import { withErrorHandling } from "@/lib/apiError";

export async function POST(req: NextRequest) {
  return withErrorHandling(async () => {
    const body = (await req.json().catch(() => null)) as { address?: string } | null;
    if (!body?.address) {
      return NextResponse.json({ error: "address is required", retryable: false }, { status: 400 });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    pruneExpiredChallenges(nowSeconds);

    const challenge = createChallenge(body.address, nowSeconds);
    putChallenge(challenge);

    return NextResponse.json({
      nonce: challenge.nonce,
      message: challengeMessage(challenge),
    });
  });
}
