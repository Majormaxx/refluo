import { NextRequest, NextResponse } from "next/server";
import {
  readAlertsConfig,
  writeAlertsConfig,
  validateAlertsConfigPatch,
  type AlertsConfig,
} from "@/lib/alertsConfig";
import { requireAdminSession } from "@/lib/auth/getSession";
import { withErrorHandling, ApiError } from "@/lib/apiError";

export async function GET() {
  return withErrorHandling(async () => {
    await requireAdminSession();
    return NextResponse.json(readAlertsConfig());
  });
}

export async function PUT(req: NextRequest) {
  return withErrorHandling(async () => {
    await requireAdminSession();
    const body = await req.json().catch(() => {
      throw new ApiError("malformed JSON body", 400);
    });
    const validationError = validateAlertsConfigPatch(body);
    if (validationError) {
      throw new ApiError(validationError, 400);
    }
    const current = readAlertsConfig();
    const updated: AlertsConfig = { ...current, ...(body as Partial<AlertsConfig>) };
    writeAlertsConfig(updated);
    return NextResponse.json(updated);
  });
}
