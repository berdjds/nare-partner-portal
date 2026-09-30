import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission, INTERNAL_PERMISSION_KEYS } from "@/lib/permissions";
import { getPermissionsMigrationConfirmation } from "@/lib/permissions-report";
import bcrypt from "bcryptjs";
import { z } from "zod";

// WhatsApp notification destination: digits with an optional leading +
// (stored without the +, matching the schema comment on User.phone).
const phoneSchema = z
  .string()
  .regex(/^\+?\d{7,15}$/, "expected 7-15 digits, optional leading +")
  .transform((v) => v.replace(/^\+/, ""))
  .nullish();

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(4),
  role: z.enum(["ADMIN", "USER", "ADVISOR", "VALIDATOR"]).default("USER"),
  phone: phoneSchema,
});

const updateSchema = z.object({
  id: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  role: z.enum(["ADMIN", "USER", "ADVISOR", "VALIDATOR"]).optional(),
  active: z.boolean().optional(),
  password: z.string().min(4).optional(),
  phone: phoneSchema,
});

const deleteSchema = z.object({
  id: z.string().min(1),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || !hasPermission(user, "admin.users")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, name: true, role: true, active: true, phone: true, createdAt: true, updatedAt: true },
  });

  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || !hasPermission(user, "admin.users")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const hashed = await bcrypt.hash(parsed.data.password, 10);
    const created = await prisma.user.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name,
        password: hashed,
        role: parsed.data.role,
        phone: parsed.data.phone ?? null,
      },
      select: { id: true, email: true, name: true, role: true, active: true, phone: true, createdAt: true },
    });

    await writeAuditLog("USER_CREATED", user.id, `Created ${created.email}`);

    return NextResponse.json(created);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to create user" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || !hasPermission(user, "admin.users")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  const { id, password, ...rest } = parsed.data;
  const data: any = { ...rest };
  if (password) data.password = await bcrypt.hash(password, 10);

  // W1b: account changes that must invalidate existing sessions (new
  // password, role change, transition to inactive) bump sessionVersion, so
  // every token minted before the change fails the sv comparison in
  // getActiveUser() on its next request. No-op role/active values and
  // name/email/phone-only edits do not bump. A missing row keeps the old
  // behavior: the update below throws and the catch answers 500.
  const current = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, active: true },
  });

  // W2 guards, evaluated before any update and without audit entries:
  // an admin cannot demote or deactivate themselves through the user API
  // (permission self-edits are likewise rejected by /api/permissions), and
  // the last active administrator cannot be demoted or deactivated — that
  // would lock everyone out of user management.
  if (current) {
    if (current.id === user.id) {
      if (parsed.data.role !== undefined && parsed.data.role !== current.role) {
        return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
      }
      if (parsed.data.active === false) {
        return NextResponse.json({ error: "Cannot deactivate yourself" }, { status: 400 });
      }
    }
    if (
      current.role === "ADMIN" &&
      current.active &&
      ((parsed.data.role !== undefined && parsed.data.role !== "ADMIN") || parsed.data.active === false)
    ) {
      const otherAdmins = await prisma.user.count({
        where: { role: "ADMIN", active: true, id: { not: current.id } },
      });
      if (otherAdmins === 0) {
        return NextResponse.json(
          { error: "Cannot demote or deactivate the last active administrator" },
          { status: 400 },
        );
      }
    }
    // D2/D3 internal lock, demote path: while the proposed-permissions report
    // is unconfirmed, demoting an ADMIN who still holds an internal-cost grant
    // row would hand that key to a non-admin (the permissions PUT cannot grant
    // it in this state, but legacy rows may exist). Deactivation is safe — an
    // inactive account passes no gate either way.
    if (
      current.role === "ADMIN" &&
      parsed.data.role !== undefined &&
      parsed.data.role !== "ADMIN" &&
      !(await getPermissionsMigrationConfirmation())
    ) {
      const internalGrants = await prisma.userPermission.count({
        where: { userId: current.id, key: { in: Array.from(INTERNAL_PERMISSION_KEYS) }, allowed: true },
      });
      if (internalGrants > 0) {
        return NextResponse.json(
          {
            error:
              "Remove internal-cost grants before demoting: internal permissions stay admin-only until the proposed-permissions report is confirmed",
          },
          { status: 400 },
        );
      }
    }
  }

  if (
    current &&
    (password ||
      (parsed.data.role !== undefined && parsed.data.role !== current.role) ||
      (parsed.data.active === false && current.active))
  ) {
    data.sessionVersion = { increment: 1 };
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, active: true, phone: true, createdAt: true },
    });

    await writeAuditLog("USER_UPDATED", user.id, `Updated ${updated.email}`);

    return NextResponse.json(updated);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to update user" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || !hasPermission(user, "admin.users")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // Load the target up front: a missing id must answer 404, not fall into the
  // 500 catch when the delete below throws.
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, active: true },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Prevent self-deletion
  if (id === user.id) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  // W2: deleting the last active administrator would lock everyone out of
  // user management (same rationale as the PATCH last-admin guard).
  if (target.role === "ADMIN" && target.active) {
    const otherAdmins = await prisma.user.count({
      where: { role: "ADMIN", active: true, id: { not: target.id } },
    });
    if (otherAdmins === 0) {
      return NextResponse.json({ error: "Cannot delete the last active administrator" }, { status: 400 });
    }
  }

  try {
    await prisma.user.delete({ where: { id } });
    await writeAuditLog("USER_DELETED", user.id, `Deleted user ${id}`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to delete user" }, { status: 500 });
  }
}
