/**
 * QA: regression checks for pre-existing WAControl routes (item 17) —
 * the travel module must not have changed their behavior.
 *
 * /api/chats GET: any authenticated session → 200; anonymous → 401.
 * /api/users GET/POST: ADMIN only; 401 for USER and anonymous; POST creates.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

let prisma: PrismaClient;
let chatsGET: typeof import("@/app/api/chats/route").GET;
let usersRoute: typeof import("@/app/api/users/route");

function session(user: { id: string; role: string; email: string } | null) {
  sessionRef.current = user
    ? { user, expires: "2099-01-01" }
    : null;
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  chatsGET = (await import("@/app/api/chats/route")).GET;
  usersRoute = await import("@/app/api/users/route");

  await prisma.user.create({
    data: { email: "reg-admin@test.io", name: "Reg Admin", password: "x", role: "ADMIN" },
  });
  await prisma.user.create({
    data: { email: "reg-user@test.io", name: "Reg User", password: "x", role: "USER" },
  });
  const chat = await prisma.chat.create({
    data: { remoteJid: "374111@c.us", name: "Regression Chat", phone: "374111" },
  });
  await prisma.message.create({
    data: {
      whatsappMessageId: "reg-msg-1",
      chatId: chat.id,
      remoteJid: chat.remoteJid,
      fromMe: false,
      body: "hello",
      type: "text",
      timestamp: new Date(),
    },
  });
});

describe("GET /api/chats", () => {
  it("returns chats with the latest message for any session, 401 when anonymous", async () => {
    session(null);
    expect((await chatsGET(new NextRequest("http://localhost:3000/api/chats"))).status).toBe(401);

    const user = await prisma.user.findUnique({ where: { email: "reg-user@test.io" } });
    session({ id: user!.id, role: "USER", email: user!.email });
    const res = await chatsGET(new NextRequest("http://localhost:3000/api/chats"));
    expect(res.status).toBe(200);
    const chats = await res.json();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe("Regression Chat");
    expect(chats[0].messages[0].body).toBe("hello");
  });
});

describe("GET /api/users", () => {
  it("is ADMIN-only: 401 for USER and anonymous, 200 for ADMIN", async () => {
    const admin = await prisma.user.findUnique({ where: { email: "reg-admin@test.io" } });
    const user = await prisma.user.findUnique({ where: { email: "reg-user@test.io" } });

    session(null);
    expect((await usersRoute.GET()).status).toBe(401);
    session({ id: user!.id, role: "USER", email: user!.email });
    expect((await usersRoute.GET()).status).toBe(401);

    session({ id: admin!.id, role: "ADMIN", email: admin!.email });
    const res = await usersRoute.GET();
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(users.some((u: any) => u.email === "reg-admin@test.io")).toBe(true);
    // The listing must not leak password hashes.
    expect(users.every((u: any) => u.password === undefined)).toBe(true);
  });
});

describe("POST /api/users", () => {
  it("creates a user as ADMIN and rejects non-admins", async () => {
    const admin = await prisma.user.findUnique({ where: { email: "reg-admin@test.io" } });
    const user = await prisma.user.findUnique({ where: { email: "reg-user@test.io" } });

    const body = { email: "reg-new@test.io", name: "New", password: "secret1", role: "USER" };
    session({ id: user!.id, role: "USER", email: user!.email });
    const denied = await usersRoute.POST(
      new Request("http://t/api/users", { method: "POST", body: JSON.stringify(body) }) as any,
    );
    expect(denied.status).toBe(401);

    session({ id: admin!.id, role: "ADMIN", email: admin!.email });
    const res = await usersRoute.POST(
      new Request("http://t/api/users", { method: "POST", body: JSON.stringify(body) }) as any,
    );
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created.email).toBe("reg-new@test.io");
    const inDb = await prisma.user.findUnique({ where: { email: "reg-new@test.io" } });
    expect(inDb).toBeTruthy();
    expect(inDb!.password).not.toBe("secret1"); // bcrypt-hashed
    const audit = await prisma.log.findFirst({ where: { action: "USER_CREATED", details: { contains: "reg-new@test.io" } } });
    expect(audit).toBeTruthy();
  });
});
