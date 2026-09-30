import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/access-policy";
import { presetForRole } from "@/lib/permissions";
import {
  getPermissionsMigrationConfirmation,
  recordPermissionsMigrationConfirmation,
} from "@/lib/permissions-report";

// W2 (D3) proposed-permissions report (perm-admin). Shows every existing user
// with the preset they would receive, and carries the single Confirm action
// that unlocks internal-cost grants for non-admins. Both handlers require the
// effective admin.users permission.

export async function GET() {
  const session = await getServerSession(authOptions);
  const access = await requirePermission(session, "admin.users");
  if (!access.allowed) return access.response;

  const [confirmation, users] = await Promise.all([
    getPermissionsMigrationConfirmation(),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, name: true, role: true, active: true },
    }),
  ]);

  return NextResponse.json({
    confirmed: !!confirmation,
    confirmedAt: confirmation?.confirmedAt.toISOString() ?? null,
    confirmedBy: confirmation?.email ?? null,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      proposed: Array.from(presetForRole(u.role)).sort(),
    })),
  });
}

export async function POST() {
  const session = await getServerSession(authOptions);
  const access = await requirePermission(session, "admin.users");
  if (!access.allowed) return access.response;

  // Confirming is one-way: a second confirm must not move the confirmed-at
  // timestamp or duplicate the audit trail.
  const existing = await getPermissionsMigrationConfirmation();
  if (existing) {
    return NextResponse.json({ error: "Proposed permissions already confirmed" }, { status: 409 });
  }

  const userCount = await prisma.user.count();
  await recordPermissionsMigrationConfirmation(access.user.id, userCount);

  const confirmation = await getPermissionsMigrationConfirmation();
  return NextResponse.json({
    confirmed: true,
    confirmedAt: confirmation?.confirmedAt.toISOString() ?? null,
  });
}
