/**
 * Interim access policy route tests (W1, msg-access): anonymous / USER /
 * ADVISOR / VALIDATOR / inactive / ADMIN against the inbox APIs
 * (/api/chats, /api/messages, /api/send), GET+POST /api/whatsapp/status and
 * the / + /dashboard page redirects. Sessions and the WhatsApp service are
 * mocked; routes run against the seeded throwaway DB, so the database-backed
 * gates (lib/access-policy.ts) are exercised end to end — including that a
 * role change or deactivation takes effect on the next request with the same
 * unexpired session.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef, waState, sendWhatsAppMessageMock } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  waState: {
    current: {
      state: "ready",
      qrSvg: "<svg>pairing-qr</svg>",
      info: "WhatsApp client is ready.",
      version: "0.0.0-test",
      startedAt: "2026-09-28T00:00:00.000Z",
    } as Record<string, unknown>,
  },
  sendWhatsAppMessageMock: { fn: vi.fn() },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppState: vi.fn(() => waState.current),
  sendWhatsAppMessage: sendWhatsAppMessageMock.fn,
  logoutWhatsApp: vi.fn(async () => undefined),
  initializeWhatsApp: vi.fn(async () => ({})),
  restartWhatsApp: vi.fn(async () => ({})),
}));

let prisma: PrismaClient;
let chatsGET: typeof import("@/app/api/chats/route").GET;
let messagesGET: typeof import("@/app/api/messages/route").GET;
let sendPOST: typeof import("@/app/api/send/route").POST;
let statusGET: typeof import("@/app/api/whatsapp/status/route").GET;
let statusPOST: typeof import("@/app/api/whatsapp/status/route").POST;
let HomePage: typeof import("@/app/page").default;
let DashboardPage: typeof import("@/app/dashboard/page").default;

let admin: { id: string; email: string; name: string | null; role: string };
let user: { id: string; email: string; name: string | null; role: string };
let advisor: { id: string; email: string; name: string | null; role: string };
let validator: { id: string; email: string; name: string | null; role: string };
let inactive: { id: string; email: string; name: string | null; role: string };
let chat: { id: string; remoteJid: string };

/** Session the way NextAuth returns it; `role` stands in for the JWT-claimed role, `sv` for the session-version claim (W1b). */
function login(
  u: { id: string; email: string; name: string | null; role: string } | null,
  roleOverride?: string,
  sv?: number,
) {
  sessionRef.current = u
    ? {
        user: { id: u.id, role: roleOverride ?? u.role, email: u.email, name: u.name, ...(sv !== undefined ? { sv } : {}) },
        expires: "2099-01-01",
      }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

/** Runs a page and returns the redirect target, or null when it rendered. */
async function redirectTarget(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (err: any) {
    if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
      return err.digest.split(";")[2];
    }
    throw err;
  }
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  chatsGET = (await import("@/app/api/chats/route")).GET;
  messagesGET = (await import("@/app/api/messages/route")).GET;
  sendPOST = (await import("@/app/api/send/route")).POST;
  statusGET = (await import("@/app/api/whatsapp/status/route")).GET;
  statusPOST = (await import("@/app/api/whatsapp/status/route")).POST;
  HomePage = (await import("@/app/page")).default;
  DashboardPage = (await import("@/app/dashboard/page")).default;

  admin = await prisma.user.create({ data: { email: "acc-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  user = await prisma.user.create({ data: { email: "acc-user@test.io", name: "User", password: "x", role: "USER" } });
  advisor = await prisma.user.create({ data: { email: "acc-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" } });
  validator = await prisma.user.create({ data: { email: "acc-validator@test.io", name: "Validator", password: "x", role: "VALIDATOR" } });
  inactive = await prisma.user.create({
    data: { email: "acc-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
  });
  chat = await prisma.chat.create({ data: { remoteJid: "37420000001@c.us", name: "Access Chat" } });
  await prisma.message.create({
    data: { chatId: chat.id, remoteJid: chat.remoteJid, whatsappMessageId: "acc-msg-1", fromMe: false, body: "hi", type: "text" },
  });
});

beforeEach(() => {
  login(null);
  waState.current = {
    state: "ready",
    qrSvg: "<svg>pairing-qr</svg>",
    info: "WhatsApp client is ready.",
    version: "0.0.0-test",
    startedAt: "2026-09-28T00:00:00.000Z",
  };
  sendWhatsAppMessageMock.fn.mockReset();
  sendWhatsAppMessageMock.fn.mockResolvedValue({ id: { _serialized: "wamid.acc.1" } });
});

describe("GET /api/chats", () => {
  it("401 anonymous and inactive; 403 ADVISOR/VALIDATOR; 200 USER and ADMIN", async () => {
    login(null);
    expect((await chatsGET()).status).toBe(401);
    login(inactive);
    expect((await chatsGET()).status).toBe(401);

    for (const who of [advisor, validator]) {
      login(who);
      const res = await chatsGET();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Forbidden");
    }

    for (const who of [user, admin]) {
      login(who);
      const res = await chatsGET();
      expect(res.status).toBe(200);
      expect((await res.json()).some((c: any) => c.id === chat.id)).toBe(true);
    }
  });
});

describe("GET /api/messages", () => {
  const url = (id: string) => `http://localhost:3000/api/messages?chatId=${id}`;

  it("401 anonymous and inactive; 403 ADVISOR/VALIDATOR; 200 USER and ADMIN", async () => {
    login(null);
    expect((await messagesGET(req(url(chat.id)))).status).toBe(401);
    login(inactive);
    expect((await messagesGET(req(url(chat.id)))).status).toBe(401);

    for (const who of [advisor, validator]) {
      login(who);
      expect((await messagesGET(req(url(chat.id)))).status).toBe(403);
    }

    for (const who of [user, admin]) {
      login(who);
      const res = await messagesGET(req(url(chat.id)));
      expect(res.status).toBe(200);
      expect((await res.json()).some((m: any) => m.whatsappMessageId === "acc-msg-1")).toBe(true);
    }
  });
});

describe("POST /api/send", () => {
  const validBody = { remoteJid: "37420000002@c.us", body: "hello", type: "text" };

  it("401 anonymous and inactive; never touches WhatsApp", async () => {
    login(null);
    let res = await sendPOST(req("http://localhost:3000/api/send", { method: "POST", body: validBody }));
    expect(res.status).toBe(401);
    login(inactive);
    res = await sendPOST(req("http://localhost:3000/api/send", { method: "POST", body: validBody }));
    expect(res.status).toBe(401);
    expect(sendWhatsAppMessageMock.fn).not.toHaveBeenCalled();
  });

  it("403 ADVISOR/VALIDATOR and does not send", async () => {
    for (const who of [advisor, validator]) {
      login(who);
      const res = await sendPOST(req("http://localhost:3000/api/send", { method: "POST", body: validBody }));
      expect(res.status).toBe(403);
    }
    expect(sendWhatsAppMessageMock.fn).not.toHaveBeenCalled();
    expect(await prisma.log.count({ where: { action: "SEND_MESSAGE" } })).toBe(0);
  });

  it("200 for USER and ADMIN with the audit entry attributed to the DB user", async () => {
    for (const who of [user, admin]) {
      login(who);
      const res = await sendPOST(req("http://localhost:3000/api/send", { method: "POST", body: validBody }));
      expect(res.status).toBe(200);
    }
    const audit = await prisma.log.findFirst({ where: { action: "SEND_MESSAGE", userId: user.id } });
    expect(audit).toBeTruthy();
  });
});

describe("GET /api/whatsapp/status", () => {
  it("401 anonymous and inactive", async () => {
    login(null);
    expect((await statusGET()).status).toBe(401);
    login(inactive);
    expect((await statusGET()).status).toBe(401);
  });

  it("403 for ADVISOR and VALIDATOR", async () => {
    for (const who of [advisor, validator]) {
      login(who);
      expect((await statusGET()).status).toBe(403);
    }
  });

  it("USER receives only { connected } — no state, info, QR, version or startedAt", async () => {
    login(user);
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });

    waState.current = { ...waState.current, state: "qr" };
    expect(await (await statusGET()).json()).toEqual({ connected: false });
  });

  it("ADMIN receives the full details incl. QR, version and startedAt", async () => {
    login(admin);
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      state: "ready",
      qrSvg: "<svg>pairing-qr</svg>",
      info: "WhatsApp client is ready.",
      version: "0.0.0-test",
      startedAt: "2026-09-28T00:00:00.000Z",
    });
  });
});

describe("POST /api/whatsapp/status", () => {
  const action = { method: "POST", body: { action: "reconnect" } };

  it("stays ADMIN-only: 401 for anonymous, USER, ADVISOR, VALIDATOR and inactive", async () => {
    login(null);
    expect((await statusPOST(req("http://localhost:3000/api/whatsapp/status", action))).status).toBe(401);
    for (const who of [user, advisor, validator, inactive]) {
      login(who);
      expect((await statusPOST(req("http://localhost:3000/api/whatsapp/status", action))).status).toBe(401);
    }
  });

  it("ADMIN actions succeed", async () => {
    login(admin);
    const res = await statusPOST(req("http://localhost:3000/api/whatsapp/status", action));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("page / (role-based redirect)", () => {
  it("anonymous → /login; inactive → /login", async () => {
    login(null);
    expect(await redirectTarget(() => HomePage())).toBe("/login");
    login(inactive);
    expect(await redirectTarget(() => HomePage())).toBe("/login");
  });

  it("ADMIN → /admin; USER → /dashboard; ADVISOR/VALIDATOR → /travel", async () => {
    login(admin);
    expect(await redirectTarget(() => HomePage())).toBe("/admin");
    login(user);
    expect(await redirectTarget(() => HomePage())).toBe("/dashboard");
    login(advisor);
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
    login(validator);
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
  });
});

describe("page /dashboard (inbox roles only)", () => {
  it("anonymous → /login; inactive → /login", async () => {
    login(null);
    expect(await redirectTarget(() => DashboardPage())).toBe("/login");
    login(inactive);
    expect(await redirectTarget(() => DashboardPage())).toBe("/login");
  });

  it("ADVISOR/VALIDATOR → /travel; USER and ADMIN render the dashboard", async () => {
    login(advisor);
    expect(await redirectTarget(() => DashboardPage())).toBe("/travel");
    login(validator);
    expect(await redirectTarget(() => DashboardPage())).toBe("/travel");

    login(user);
    expect(await redirectTarget(() => DashboardPage())).toBeNull();
    login(admin);
    expect(await redirectTarget(() => DashboardPage())).toBeNull();
  });
});

describe("role change / deactivation takes effect on the next request (same unexpired session)", () => {
  it("chats: USER → 200; DB role flipped to ADVISOR → 403; deactivated → 401", async () => {
    login(user); // the JWT-claimed role stays "USER" throughout
    expect((await chatsGET()).status).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADVISOR" } });
    login(user, "USER"); // simulate a stale JWT still claiming USER
    const denied = await chatsGET();
    expect(denied.status).toBe(403);

    await prisma.user.update({ where: { id: user.id }, data: { active: false } });
    expect((await chatsGET()).status).toBe(401);

    // Restore for other suites in this file.
    await prisma.user.update({ where: { id: user.id }, data: { role: "USER", active: true } });
    login(user);
    expect((await chatsGET()).status).toBe(200);
  });

  it("status: a stale JWT claiming USER cannot read admin details after a role change", async () => {
    login(user); // DB role USER, JWT role USER
    expect(await (await statusGET()).json()).toEqual({ connected: true });

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    login(user, "USER"); // same unexpired token, still claiming USER
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect((await res.json()).qrSvg).toBe("<svg>pairing-qr</svg>"); // now allowed: DB says ADMIN

    await prisma.user.update({ where: { id: user.id }, data: { role: "USER" } });
  });
});

describe("session version revocation takes effect on the next request (W1b)", () => {
  it("a stale sv loses the inbox (401 on /api/chats, /login on /) until the session carries the current sv", async () => {
    // Dedicated user: the shared fixtures above are reused by other suites.
    const bumped = await prisma.user.create({
      data: { email: "acc-bumped@test.io", name: "Bumped", password: "x", role: "USER" },
    });
    login(bumped, undefined, 0);
    expect((await chatsGET()).status).toBe(200);
    expect(await redirectTarget(() => HomePage())).toBe("/dashboard");

    // Revoke all issued sessions: bump User.sessionVersion atomically (the
    // same { increment: 1 } update revokeAllSessions performs).
    await prisma.user.update({ where: { id: bumped.id }, data: { sessionVersion: { increment: 1 } } });

    login(bumped, undefined, 0); // the stale token still claims the old sv
    expect((await chatsGET()).status).toBe(401);
    expect(await redirectTarget(() => HomePage())).toBe("/login");

    // A pre-W1b token without any sv claim counts as 0 — a real version, not
    // a bypass — so the bump revokes it like any other stale token.
    login(bumped);
    expect((await chatsGET()).status).toBe(401);
    expect(await redirectTarget(() => HomePage())).toBe("/login");

    // Re-login at the current version restores access.
    login(bumped, undefined, 1);
    expect((await chatsGET()).status).toBe(200);
    expect(await redirectTarget(() => HomePage())).toBe("/dashboard");
  });
});
