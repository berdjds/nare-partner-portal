/**
 * W3 (wa-multi) per-account permission gates on the inbox APIs: /api/chats,
 * /api/messages, /api/send and GET+POST /api/whatsapp/status, now that the
 * runtime runs two WhatsApp accounts — 'marhaba' (the default; the legacy
 * whatsapp.inbox.* / whatsapp.admin keys) and 'nare' (its own
 * whatsapp.nare.* triple, in no non-admin preset).
 *
 * Sessions and the WhatsApp service are mocked; routes run against the
 * seeded throwaway DB with the real audit writer, so the DB-backed gates
 * (requirePermission over effective permissions: role preset + UserPermission
 * grants − denies) are exercised end to end per account. A plain USER proves
 * marhaba back-compat (no ?account= behaves exactly as before), and ADVISOR
 * personas with per-user nare grants prove the nare triple opens exactly the
 * surfaces it should — and nothing else.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef, waStates, sendMock, restartMock } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  waStates: {
    current: {
      marhaba: {
        state: "ready",
        qrSvg: "<svg>marhaba-qr</svg>",
        info: "Marhaba client is ready.",
        version: "0.0.0-test",
        startedAt: "2026-09-28T00:00:00.000Z",
      },
      nare: {
        state: "ready",
        qrSvg: "<svg>nare-qr</svg>",
        info: "Nare client is ready.",
        version: "0.0.0-test",
        startedAt: "2026-09-29T00:00:00.000Z",
      },
    } as Record<string, Record<string, unknown>>,
  },
  sendMock: { fn: vi.fn() },
  restartMock: { fn: vi.fn() },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppState: vi.fn((accountKey: string) => waStates.current[accountKey]),
  sendWhatsAppMessage: sendMock.fn,
  logoutWhatsApp: vi.fn(async () => undefined),
  initializeWhatsApp: vi.fn(async () => ({})),
  restartWhatsApp: restartMock.fn,
}));

let prisma: PrismaClient;
let chatsGET: typeof import("@/app/api/chats/route").GET;
let messagesGET: typeof import("@/app/api/messages/route").GET;
let sendPOST: typeof import("@/app/api/send/route").POST;
let statusGET: typeof import("@/app/api/whatsapp/status/route").GET;
let statusPOST: typeof import("@/app/api/whatsapp/status/route").POST;

type TestUser = { id: string; email: string; name: string | null; role: string };

let user: TestUser; // USER preset: marhaba view+send only, no nare keys
let nareView: TestUser; // ADVISOR + whatsapp.nare.view
let nareSend: TestUser; // ADVISOR + whatsapp.nare.view + whatsapp.nare.send
let nareAdmin: TestUser; // ADVISOR + whatsapp.nare.admin
let admin: TestUser;
let marhabaChat: { id: string; remoteJid: string };
let nareChat: { id: string; remoteJid: string };

const MARHABA_STATE = {
  state: "ready",
  qrSvg: "<svg>marhaba-qr</svg>",
  info: "Marhaba client is ready.",
  version: "0.0.0-test",
  startedAt: "2026-09-28T00:00:00.000Z",
};
const NARE_STATE = {
  state: "ready",
  qrSvg: "<svg>nare-qr</svg>",
  info: "Nare client is ready.",
  version: "0.0.0-test",
  startedAt: "2026-09-29T00:00:00.000Z",
};

function login(u: TestUser | null) {
  sessionRef.current = u
    ? { user: { id: u.id, role: u.role, email: u.email, name: u.name }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  chatsGET = (await import("@/app/api/chats/route")).GET;
  messagesGET = (await import("@/app/api/messages/route")).GET;
  sendPOST = (await import("@/app/api/send/route")).POST;
  statusGET = (await import("@/app/api/whatsapp/status/route")).GET;
  statusPOST = (await import("@/app/api/whatsapp/status/route")).POST;

  user = await prisma.user.create({ data: { email: "w3-user@test.io", name: "User", password: "x", role: "USER" } });
  admin = await prisma.user.create({ data: { email: "w3-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });

  nareView = await prisma.user.create({
    data: { email: "w3-nare-view@test.io", name: "Nare View", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({ data: { userId: nareView.id, key: "whatsapp.nare.view", allowed: true } });

  nareSend = await prisma.user.create({
    data: { email: "w3-nare-send@test.io", name: "Nare Send", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({ data: { userId: nareSend.id, key: "whatsapp.nare.view", allowed: true } });
  await prisma.userPermission.create({ data: { userId: nareSend.id, key: "whatsapp.nare.send", allowed: true } });

  nareAdmin = await prisma.user.create({
    data: { email: "w3-nare-admin@test.io", name: "Nare Admin", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({ data: { userId: nareAdmin.id, key: "whatsapp.nare.admin", allowed: true } });

  // Chat identity is (accountId, remoteJid); messages dedupe per account.
  marhabaChat = await prisma.chat.create({
    data: { accountId: "marhaba", remoteJid: "37420000101@c.us", name: "Marhaba Chat" },
  });
  await prisma.message.create({
    data: {
      accountId: "marhaba",
      chatId: marhabaChat.id,
      remoteJid: marhabaChat.remoteJid,
      whatsappMessageId: "w3-marhaba-msg-1",
      fromMe: false,
      body: "marhaba hello",
      type: "text",
    },
  });
  nareChat = await prisma.chat.create({
    data: { accountId: "nare", remoteJid: "37420000102@c.us", name: "Nare Chat" },
  });
  await prisma.message.create({
    data: {
      accountId: "nare",
      chatId: nareChat.id,
      remoteJid: nareChat.remoteJid,
      whatsappMessageId: "w3-nare-msg-1",
      fromMe: false,
      body: "nare hello",
      type: "text",
    },
  });
});

beforeEach(() => {
  login(null);
  waStates.current = { marhaba: { ...MARHABA_STATE }, nare: { ...NARE_STATE } };
  sendMock.fn.mockReset();
  sendMock.fn.mockResolvedValue({ id: { _serialized: "wamid.w3.1" } });
  restartMock.fn.mockReset();
  restartMock.fn.mockResolvedValue({});
});

describe("GET /api/chats (per account)", () => {
  it("no ?account= lists marhaba for a USER (back-compat) and never leaks the nare chat", async () => {
    login(user);
    const res = await chatsGET(req("http://localhost:3000/api/chats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((c: any) => c.id === marhabaChat.id)).toBe(true);
    expect(body.some((c: any) => c.id === nareChat.id)).toBe(false);
  });

  it("?account=nare: USER is 403; the nare-view grantee gets 200 with only the nare chat", async () => {
    login(user);
    expect((await chatsGET(req("http://localhost:3000/api/chats?account=nare"))).status).toBe(403);

    login(nareView);
    const res = await chatsGET(req("http://localhost:3000/api/chats?account=nare"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((c: any) => c.id === nareChat.id)).toBe(true);
    expect(body.some((c: any) => c.id === marhabaChat.id)).toBe(false);
  });

  it("?account=bogus is 400 for any role, before the permission gate", async () => {
    for (const who of [user, nareView, admin]) {
      login(who);
      const res = await chatsGET(req("http://localhost:3000/api/chats?account=bogus"));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Unknown WhatsApp account");
    }
  });
});

describe("GET /api/messages (per account)", () => {
  const url = (chatId: string, account?: string) =>
    `http://localhost:3000/api/messages?chatId=${chatId}${account ? `&account=${account}` : ""}`;

  it("?account=nare: USER is 403; the nare-view grantee gets the nare message", async () => {
    login(user);
    expect((await messagesGET(req(url(nareChat.id, "nare")))).status).toBe(403);

    login(nareView);
    const res = await messagesGET(req(url(nareChat.id, "nare")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((m: any) => m.whatsappMessageId === "w3-nare-msg-1")).toBe(true);
  });

  it("no ?account= with the nare chatId stays marhaba-scoped (the nare message is not returned)", async () => {
    login(user);
    const res = await messagesGET(req(url(nareChat.id)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((m: any) => m.whatsappMessageId === "w3-nare-msg-1")).toBe(false);
    expect(body).toHaveLength(0);
  });

  it("no ?account= returns the marhaba chat's messages to a USER (back-compat)", async () => {
    login(user);
    const res = await messagesGET(req(url(marhabaChat.id)));
    expect(res.status).toBe(200);
    expect((await res.json()).some((m: any) => m.whatsappMessageId === "w3-marhaba-msg-1")).toBe(true);
  });
});

describe("POST /api/send (per account)", () => {
  const sendBody = { remoteJid: "37420000103@c.us", body: "hello", type: "text" };
  const sendReq = (body: unknown = sendBody) =>
    req("http://localhost:3000/api/send", { method: "POST", body });

  it("body without account sends through marhaba (back-compat) for a USER", async () => {
    login(user);
    const res = await sendPOST(sendReq());
    expect(res.status).toBe(200);
    expect(sendMock.fn).toHaveBeenCalledTimes(1);
    expect(sendMock.fn).toHaveBeenCalledWith(expect.objectContaining({ accountKey: "marhaba" }));
  });

  it("account 'nare': USER is 403 and nothing is sent", async () => {
    login(user);
    const res = await sendPOST(sendReq({ ...sendBody, account: "nare" }));
    expect(res.status).toBe(403);
    expect(sendMock.fn).not.toHaveBeenCalled();
  });

  it("account 'nare': the nare-send grantee sends with accountKey 'nare'", async () => {
    login(nareSend);
    const res = await sendPOST(sendReq({ ...sendBody, account: "nare" }));
    expect(res.status).toBe(200);
    expect(sendMock.fn).toHaveBeenCalledTimes(1);
    expect(sendMock.fn).toHaveBeenCalledWith(
      expect.objectContaining({ accountKey: "nare", remoteJid: sendBody.remoteJid }),
    );
    // The audit entry attributes the send to the granting account.
    const audit = await prisma.log.findFirst({ where: { action: "SEND_MESSAGE", userId: nareSend.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("[nare]");
  });

  it("a nare-view grant without the send key still cannot send", async () => {
    login(nareView);
    const res = await sendPOST(sendReq({ ...sendBody, account: "nare" }));
    expect(res.status).toBe(403);
    expect(sendMock.fn).not.toHaveBeenCalled();
  });

  it("unknown account is 400 and nothing is sent", async () => {
    login(user);
    const res = await sendPOST(sendReq({ ...sendBody, account: "bogus" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown WhatsApp account");
    expect(sendMock.fn).not.toHaveBeenCalled();
  });

  it("503 when the nare client is not ready, even for the nare-send grantee", async () => {
    login(nareSend);
    waStates.current.nare = { ...waStates.current.nare, state: "qr" };
    const res = await sendPOST(sendReq({ ...sendBody, account: "nare" }));
    expect(res.status).toBe(503);
    expect(sendMock.fn).not.toHaveBeenCalled();
  });

  it("503 on marhaba does not block a ready nare (state is per account)", async () => {
    login(nareSend);
    waStates.current.marhaba = { ...waStates.current.marhaba, state: "disconnected" };
    const res = await sendPOST(sendReq({ ...sendBody, account: "nare" }));
    expect(res.status).toBe(200);
    expect(sendMock.fn).toHaveBeenCalledWith(expect.objectContaining({ accountKey: "nare" }));
  });
});

describe("GET /api/whatsapp/status (per account)", () => {
  const url = (account?: string) =>
    `http://localhost:3000/api/whatsapp/status${account ? `?account=${account}` : ""}`;

  it("?account=nare: USER is 403 (no nare keys)", async () => {
    login(user);
    expect((await statusGET(req(url("nare")))).status).toBe(403);
  });

  it("?account=nare: the nare-view grantee gets exactly { connected } — no state/info/qrSvg", async () => {
    login(nareView);
    const res = await statusGET(req(url("nare")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true });

    waStates.current.nare = { ...waStates.current.nare, state: "qr" };
    expect(await (await statusGET(req(url("nare")))).json()).toEqual({ connected: false });
  });

  it("?account=nare: the nare-admin grantee gets the full nare state incl. qrSvg", async () => {
    login(nareAdmin);
    const res = await statusGET(req(url("nare")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NARE_STATE);
  });

  it("?account=bogus is 400", async () => {
    login(admin);
    const res = await statusGET(req(url("bogus")));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown WhatsApp account");
  });

  it("no ?account= returns the full marhaba state to an ADMIN (back-compat)", async () => {
    login(admin);
    const res = await statusGET(req(url()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MARHABA_STATE);
  });
});

describe("POST /api/whatsapp/status (per account)", () => {
  const actionReq = (body: unknown) =>
    req("http://localhost:3000/api/whatsapp/status", { method: "POST", body });

  it("reconnect on nare: 401 for USER and the nare-view grantee", async () => {
    for (const who of [user, nareView]) {
      login(who);
      expect((await statusPOST(actionReq({ action: "reconnect", account: "nare" }))).status).toBe(401);
    }
    expect(restartMock.fn).not.toHaveBeenCalled();
  });

  it("reconnect on nare: the nare-admin grantee gets 200 and restartWhatsApp('nare') only", async () => {
    login(nareAdmin);
    const res = await statusPOST(actionReq({ action: "reconnect", account: "nare" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // The route schedules restartWhatsApp(accountKey) via setTimeout(1000).
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1300));
    expect(restartMock.fn).toHaveBeenCalledTimes(1);
    expect(restartMock.fn).toHaveBeenCalledWith("nare");
    expect(restartMock.fn).not.toHaveBeenCalledWith("marhaba");
  });

  it("reconnect without account targets marhaba (back-compat) for an ADMIN", async () => {
    login(admin);
    const res = await statusPOST(actionReq({ action: "reconnect" }));
    expect(res.status).toBe(200);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1300));
    expect(restartMock.fn).toHaveBeenCalledTimes(1);
    expect(restartMock.fn).toHaveBeenCalledWith("marhaba");
  });

  it("unknown account in the action body is 400", async () => {
    login(admin);
    const res = await statusPOST(actionReq({ action: "reconnect", account: "bogus" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Unknown WhatsApp account");
  });
});
