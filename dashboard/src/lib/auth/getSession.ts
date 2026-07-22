import "server-only";
import { cookies } from "next/headers";
import { verifySessionToken, type SessionPayload } from "./session";
import { requireEnv } from "../env";
import { UnauthenticatedError, ForbiddenError } from "../apiError";

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get("refluo_session")?.value;
  if (!token) {
    return null;
  }
  return verifySessionToken(token, requireEnv("SESSION_SECRET"), Math.floor(Date.now() / 1000));
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    throw new UnauthenticatedError();
  }
  return session;
}

export async function requireAdminSession(): Promise<SessionPayload> {
  const session = await requireSession();
  if (session.role !== "admin") {
    throw new ForbiddenError("admin role required");
  }
  return session;
}
