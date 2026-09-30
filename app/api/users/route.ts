import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getActiveUser } from "@/lib/access-policy";
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
  if (!user || user.role !== "ADMIN") {
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
  if (!user || user.role !== "ADMIN") {
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
  if (!user || user.role !== "ADMIN") {
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
    select: { role: true, active: true },
  });
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
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  // Prevent self-deletion
  if (id === user.id) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  try {
    await prisma.user.delete({ where: { id } });
    await writeAuditLog("USER_DELETED", user.id, `Deleted user ${id}`);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to delete user" }, { status: 500 });
  }
}
