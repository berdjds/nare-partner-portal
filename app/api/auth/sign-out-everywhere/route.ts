import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";
import { getActiveUser, revokeAllSessions } from "@/lib/access-policy";

// Self-service "sign out everywhere" (W1b). Any active logged-in user may
// call this, regardless of role (ADVISOR/VALIDATOR included), and it only
// ever revokes the caller's OWN account — the id comes from the session,
// never from the request body, so no target can be forged. Bumping
// sessionVersion invalidates every token of the caller minted before the
// bump (including pre-W1b legacy tokens) on the very next request, and open
// sockets on the next revalidation pass.
export async function POST(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await revokeAllSessions(user.id);
  await writeAuditLog("SIGN_OUT_EVERYWHERE", user.id, "Signed out everywhere (all sessions revoked)");

  return NextResponse.json({ ok: true });
}
