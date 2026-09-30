import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getActiveUser, revokeAllSessions } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";

// Admin-only session revocation (W1b). Bumping User.sessionVersion
// invalidates every token minted before the bump — including pre-W1b legacy
// tokens, whose missing sv claim reads as 0 — on the very next request via
// getActiveUser(), and open sockets on the next 60s revalidation pass.
// Unlike /api/users, this endpoint distinguishes 401 (no active session)
// from 403 (active but lacking the admin.users permission), since revocation
// tooling must not leak "admin vs not" through an ambiguous 401.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // W2: decided by the effective admin.users permission, not the role — an
  // ADMIN denied the key loses revocation access like any non-admin.
  if (!hasPermission(user, "admin.users")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  await revokeAllSessions(target.id);
  await writeAuditLog("SESSIONS_REVOKED", user.id, `Revoked all sessions of ${target.email}`);

  return NextResponse.json({ ok: true });
}
