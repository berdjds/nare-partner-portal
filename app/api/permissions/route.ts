import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission, revokeAllSessions } from "@/lib/access-policy";
import {
  PERMISSION_KEYS,
  INTERNAL_PERMISSION_KEYS,
  isPermissionKey,
  presetForRole,
  effectivePermissions,
  type PermissionKey,
} from "@/lib/permissions";
import { getPermissionsMigrationConfirmation } from "@/lib/permissions-report";

// W2 permission matrix (perm-admin). Both handlers require the effective
// admin.users permission via requirePermission(): 401 without an active
// session, 403 when the key is missing — an ADMIN denied admin.users loses
// access here exactly like a non-admin.

const putSchema = z.object({
  userId: z.string().min(1),
  // allowed=null resets the key to the role preset (deletes the override row).
  overrides: z.array(z.object({ key: z.string(), allowed: z.boolean().nullable() })),
});

interface OverrideRow {
  key: string;
  allowed: boolean;
}

function sortedEffective(role: string, overrides: OverrideRow[]): string[] {
  return Array.from(effectivePermissions(role, overrides)).sort();
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const access = await requirePermission(session, "admin.users");
  if (!access.allowed) return access.response;

  const [users, confirmation] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        permissions: { select: { key: true, allowed: true } },
      },
    }),
    getPermissionsMigrationConfirmation(),
  ]);

  return NextResponse.json({
    keys: PERMISSION_KEYS,
    // D2/D3: until the owner confirms the proposed-permissions report, the
    // internal-cost keys cannot be granted to anyone (enforced in PUT).
    internalLocked: !confirmation,
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      overrides: u.permissions,
      preset: Array.from(presetForRole(u.role)).sort(),
      effective: sortedEffective(u.role, u.permissions),
    })),
  });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const access = await requirePermission(session, "admin.users");
  if (!access.allowed) return access.response;
  const actor = access.user;

  const body = await req.json();
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  // The key set is closed: an unknown key can never become effective, so
  // storing it would only hide a client bug — reject instead. Duplicate keys
  // collapse to the last occurrence.
  const incoming = new Map<PermissionKey, boolean | null>();
  for (const entry of parsed.data.overrides) {
    if (!isPermissionKey(entry.key)) {
      return NextResponse.json({ error: `Unknown permission key: ${entry.key}` }, { status: 400 });
    }
    incoming.set(entry.key, entry.allowed);
  }

  const target = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: {
      id: true,
      email: true,
      role: true,
      active: true,
      permissions: { select: { key: true, allowed: true } },
    },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Self-edits go through neither this endpoint nor /api/users role/active
  // edits: an admin locking themselves out mid-session is always a mistake.
  if (target.id === actor.id) {
    return NextResponse.json({ error: "Cannot change your own permissions" }, { status: 400 });
  }

  // D2/D3 internal lock: internal-cost keys stay admin-only until the owner
  // confirms the proposed-permissions report, so grants are rejected for EVERY
  // target while unconfirmed. ADMIN targets are not exempt: their preset
  // already holds the keys, and an orphan grant row would keep the key if the
  // user were later demoted. Denies and resets are always allowed — they can
  // only narrow access.
  const grantsInternal = Array.from(incoming.entries()).some(
    ([key, allowed]) => allowed === true && INTERNAL_PERMISSION_KEYS.has(key),
  );
  if (grantsInternal && !(await getPermissionsMigrationConfirmation())) {
    return NextResponse.json(
      { error: "Internal-cost permissions stay admin-only until the proposed-permissions report is confirmed" },
      { status: 403 },
    );
  }

  // Resulting override set: current rows with the incoming changes applied
  // (null removes the row).
  const resultingMap = new Map<string, boolean>();
  for (const row of target.permissions) resultingMap.set(row.key, row.allowed);
  for (const [key, allowed] of Array.from(incoming.entries())) {
    if (allowed === null) resultingMap.delete(key);
    else resultingMap.set(key, allowed);
  }
  const resulting: OverrideRow[] = Array.from(resultingMap.entries()).map(([key, allowed]) => ({ key, allowed }));

  // Last-admin guard: the change must not strip admin.users from the only
  // remaining active administrator, or nobody can manage users afterwards.
  if (
    target.role === "ADMIN" &&
    target.active &&
    !effectivePermissions(target.role, resulting).has("admin.users")
  ) {
    const otherAdmins = await prisma.user.count({
      where: { role: "ADMIN", active: true, id: { not: target.id } },
    });
    if (otherAdmins === 0) {
      return NextResponse.json(
        { error: "Cannot remove admin.users from the last active administrator" },
        { status: 400 },
      );
    }
  }

  // No-op detection: a reset only changes anything when a row exists, a
  // grant/deny only when it flips the stored value. No-op saves must not bump
  // sessions or write audit noise.
  const currentMap = new Map(target.permissions.map((p) => [p.key, p.allowed]));
  const changes: { key: PermissionKey; allowed: boolean | null }[] = [];
  for (const [key, allowed] of Array.from(incoming.entries())) {
    const current = currentMap.get(key);
    if (allowed === null) {
      if (current !== undefined) changes.push({ key, allowed });
    } else if (current !== allowed) {
      changes.push({ key, allowed });
    }
  }

  if (changes.length === 0) {
    return NextResponse.json({
      ok: true,
      user: {
        id: target.id,
        overrides: [...target.permissions].sort((a, b) => a.key.localeCompare(b.key)),
        effective: sortedEffective(target.role, target.permissions),
      },
    });
  }

  const toDelete = changes.filter((c) => c.allowed === null).map((c) => c.key);
  const toUpsert = changes.filter((c) => c.allowed !== null) as { key: PermissionKey; allowed: boolean }[];

  await prisma.$transaction([
    ...(toDelete.length > 0
      ? [prisma.userPermission.deleteMany({ where: { userId: target.id, key: { in: toDelete } } })]
      : []),
    ...toUpsert.map((c) =>
      prisma.userPermission.upsert({
        where: { userId_key: { userId: target.id, key: c.key } },
        create: { userId: target.id, key: c.key, allowed: c.allowed },
        update: { allowed: c.allowed },
      }),
    ),
  ]);

  // Every permission change bumps the target's session version, so open
  // sessions and sockets pick up the new effective set on the next request or
  // revalidation pass instead of drifting until their next action is denied.
  await revokeAllSessions(target.id);

  const summary = changes
    .map((c) => `${c.key}=${c.allowed === null ? "default" : c.allowed ? "grant" : "deny"}`)
    .sort()
    .join(", ");
  await writeAuditLog("PERMISSIONS_UPDATED", actor.id, `Permissions for ${target.email}: ${summary}`);

  const overrides = resulting.sort((a, b) => a.key.localeCompare(b.key));
  return NextResponse.json({
    ok: true,
    user: { id: target.id, overrides, effective: sortedEffective(target.role, overrides) },
  });
}
