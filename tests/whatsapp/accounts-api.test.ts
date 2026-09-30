/**
 * W3 (wa-multi) admin API tests for /api/whatsapp/accounts: account listing
 * filtered by the caller's per-account admin permission, configure
 * (displayName / publicNumber / enabled) and connect / reconnect / disconnect.
 * getServerSession and the WhatsApp client service are mocked — no network,
 * no real WhatsApp client. Prisma, the default-account registry and the real
 * audit writer run against a throwaway SQLite database, so the WA_ACCOUNT_*
 * audit entries and the WhatsAppAccount row updates are verified end to end.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const {
  sessionRef,
  getWhatsAppStateMock,
  initializeWhatsAppMock,
  logoutWhatsAppMock,
  restartWhatsAppMock,
  stopWhatsAppClientMock,
} = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  getWhatsAppStateMock: vi.fn((accountKey: string) => ({ state: "ready", accountKey })),
  initializeWhatsAppMock: vi.fn(async (..._args: unknown[]) => undefined),
  logoutWhatsAppMock: vi.fn(async (..._args: unknown[]) => undefined),
  restartWhatsAppMock: vi.fn(async (..._args: unknown[]) => undefined),
  stopWhatsAppClientMock: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/whatsapp", () => ({
  getWhatsAppState: getWhatsAppStateMock,
  initializeWhatsApp: initializeWhatsAppMock,
  logoutWhatsApp: logoutWhatsAppMock,
  restartWhatsApp: restartWhatsAppMock,
  stopWhatsAppClient: stopWhatsAppClientMock,
}));

let prisma: PrismaClient;
let accountsGET: typeof import("@/app/api/whatsapp/accounts/route").GET;
let accountsPOST: typeof import("@/app/api/whatsapp/accounts/route").POST;

let admin: { id: string; email: string; role: string };
let plainUser: { id: string; email: string; role: string };
let nareAdmin: { id: string; email: string; role: string };

const WA_MOCKS = [
  initializeWhatsAppMock,
  logoutWhatsAppMock,
  restartWhatsAppMock,
  stopWhatsAppClientMock,
];

function login(user: { id: string; email: string; role: string }) {
  sessionRef.current = {
    user: { id: user.id, role: user.role, email: user.email, name: user.email },
    expires: "2099-01-01",
  };
}

function postAccounts(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/whatsapp/accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Audit rows written for the given action that target the nare account. */
function nareAuditRows(action: string) {
  return prisma.log.findMany({ where: { action, details: { contains: "[nare]" } } });
}

/** No mock may ever have been invoked for the marhaba account. */
function expectNoMarhabaClientCalls() {
  for (const mock of WA_MOCKS) {
    for (const call of mock.mock.calls) {
      expect(call[0]).not.toBe("marhaba");
    }
  }
}

async function expectNoMarhabaAuditRows() {
  const count = await prisma.log.count({
    where: {
      action: { in: ["WA_ACCOUNT_CONFIGURE", "WA_ACCOUNT_CONNECT", "WA_ACCOUNT_RECONNECT", "WA_ACCOUNT_DISCONNECT"] },
      details: { contains: "[marhaba]" },
    },
  });
  expect(count).toBe(0);
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  accountsGET = (await import("@/app/api/whatsapp/accounts/route")).GET;
  accountsPOST = (await import("@/app/api/whatsapp/accounts/route")).POST;

  admin = await prisma.user.create({
    data: { email: "wa-admin@test.io", name: "Admin", password: "x", role: "ADMIN" },
  });
  plainUser = await prisma.user.create({
    data: { email: "wa-user@test.io", name: "User", password: "x", role: "USER" },
  });
  nareAdmin = await prisma.user.create({
    data: { email: "wa-nare-admin@test.io", name: "Nare Admin", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({
    data: { userId: nareAdmin.id, key: "whatsapp.nare.admin", allowed: true },
  });
});

beforeEach(() => {
  sessionRef.current = null;
  getWhatsAppStateMock.mockClear();
  for (const mock of WA_MOCKS) mock.mockClear();
});

describe("GET /api/whatsapp/accounts", () => {
  it("returns 401 without a session", async () => {
    const res = await accountsGET();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns 401 for a USER (no account admin permission)", async () => {
    login(plainUser);
    const res = await accountsGET();
    expect(res.status).toBe(401);
  });

  it("returns both accounts with state to an ADMIN; nare ships disabled", async () => {
    login(admin);
    const res = await accountsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((a: any) => a.key).sort()).toEqual(["marhaba", "nare"]);

    const marhaba = body.find((a: any) => a.key === "marhaba");
    expect(marhaba).toMatchObject({
      displayName: "Marhaba Armenia",
      enabled: true,
      purpose: "INBOX",
      state: { state: "ready", accountKey: "marhaba" },
    });

    const nare = body.find((a: any) => a.key === "nare");
    expect(nare).toMatchObject({
      displayName: "Nare Travel and Tours",
      enabled: false,
      purpose: "TRAVEL",
      state: { state: "ready", accountKey: "nare" },
    });
    expect(nare).toHaveProperty("publicNumber");
    expect(nare).toHaveProperty("verifiedNumber");
  });

  it("returns only the nare account to an ADVISOR granted whatsapp.nare.admin", async () => {
    login(nareAdmin);
    const res = await accountsGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].key).toBe("nare");
    expect(body[0].state).toEqual({ state: "ready", accountKey: "nare" });
  });
});

describe("POST /api/whatsapp/accounts configure", () => {
  it("lets the nare admin configure nare and writes a WA_ACCOUNT_CONFIGURE audit entry", async () => {
    login(nareAdmin);
    const res = await accountsPOST(
      postAccounts({ action: "configure", account: "nare", displayName: "Nare Travel", publicNumber: "37491000002" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.account).toMatchObject({
      key: "nare",
      displayName: "Nare Travel",
      publicNumber: "37491000002",
      state: { state: "ready", accountKey: "nare" },
    });

    const row = await prisma.whatsAppAccount.findUnique({ where: { key: "nare" } });
    expect(row).toMatchObject({ displayName: "Nare Travel", publicNumber: "37491000002" });

    const audits = await nareAuditRows("WA_ACCOUNT_CONFIGURE");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const audit = audits[audits.length - 1];
    expect(audit.userId).toBe(nareAdmin.id);
    expect(audit.details).toContain('displayName="Nare Travel"');
    expect(audit.details).toContain("publicNumber=37491000002");
  });

  it("stops the client when configure disables the account, and not when enabling it again", async () => {
    login(nareAdmin);
    const disable = await accountsPOST(postAccounts({ action: "configure", account: "nare", enabled: false }));
    expect(disable.status).toBe(200);
    expect(stopWhatsAppClientMock).toHaveBeenCalledTimes(1);
    expect(stopWhatsAppClientMock).toHaveBeenCalledWith("nare");
    expect((await prisma.whatsAppAccount.findUnique({ where: { key: "nare" } }))!.enabled).toBe(false);

    stopWhatsAppClientMock.mockClear();
    const enable = await accountsPOST(postAccounts({ action: "configure", account: "nare", enabled: true }));
    expect(enable.status).toBe(200);
    expect(stopWhatsAppClientMock).not.toHaveBeenCalled();
    expect((await prisma.whatsAppAccount.findUnique({ where: { key: "nare" } }))!.enabled).toBe(true);

    expectNoMarhabaClientCalls();
  });

  it("rejects the nare admin configuring marhaba with 401 and leaves the row unchanged", async () => {
    const before = await prisma.whatsAppAccount.findUnique({ where: { key: "marhaba" } });
    login(nareAdmin);
    const res = await accountsPOST(
      postAccounts({ action: "configure", account: "marhaba", displayName: "Hijacked" })
    );
    expect(res.status).toBe(401);
    const after = await prisma.whatsAppAccount.findUnique({ where: { key: "marhaba" } });
    expect(after).toMatchObject({
      displayName: before!.displayName,
      publicNumber: before!.publicNumber,
      enabled: before!.enabled,
    });
    await expectNoMarhabaAuditRows();
  });

  it("rejects a USER configuring nare with 401", async () => {
    login(plainUser);
    const res = await accountsPOST(
      postAccounts({ action: "configure", account: "nare", displayName: "Nope" })
    );
    expect(res.status).toBe(401);
    expect((await prisma.whatsAppAccount.findUnique({ where: { key: "nare" } }))!.displayName).not.toBe("Nope");
  });

  it("rejects an unknown account key with 400", async () => {
    login(admin);
    const res = await accountsPOST(
      postAccounts({ action: "configure", account: "bogus", displayName: "Nope" })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("bogus");
    expect(await prisma.whatsAppAccount.findUnique({ where: { key: "bogus" } })).toBeNull();
  });
});

describe("POST /api/whatsapp/accounts connect / reconnect / disconnect", () => {
  it("connect schedules initializeWhatsApp for nare only and writes WA_ACCOUNT_CONNECT", async () => {
    login(nareAdmin);
    const res = await accountsPOST(postAccounts({ action: "connect", account: "nare" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "ready", accountKey: "nare" });

    // The route defers initializeWhatsApp via setTimeout(100).
    await sleep(250);
    expect(initializeWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(initializeWhatsAppMock).toHaveBeenCalledWith("nare");

    const audits = await nareAuditRows("WA_ACCOUNT_CONNECT");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[audits.length - 1].userId).toBe(nareAdmin.id);

    expectNoMarhabaClientCalls();
    await expectNoMarhabaAuditRows();
  });

  it("reconnect schedules restartWhatsApp for nare only and writes WA_ACCOUNT_RECONNECT", async () => {
    login(nareAdmin);
    const res = await accountsPOST(postAccounts({ action: "reconnect", account: "nare" }));
    expect(res.status).toBe(200);

    await sleep(250);
    expect(restartWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(restartWhatsAppMock).toHaveBeenCalledWith("nare");
    expect(initializeWhatsAppMock).not.toHaveBeenCalled();

    const audits = await nareAuditRows("WA_ACCOUNT_RECONNECT");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[audits.length - 1].userId).toBe(nareAdmin.id);

    expectNoMarhabaClientCalls();
    await expectNoMarhabaAuditRows();
  });

  it("disconnect awaits logoutWhatsApp for nare only and writes WA_ACCOUNT_DISCONNECT", async () => {
    login(nareAdmin);
    const res = await accountsPOST(postAccounts({ action: "disconnect", account: "nare" }));
    expect(res.status).toBe(200);

    // logoutWhatsApp is awaited inside the handler — no wait needed.
    expect(logoutWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(logoutWhatsAppMock).toHaveBeenCalledWith("nare");

    const audits = await nareAuditRows("WA_ACCOUNT_DISCONNECT");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[audits.length - 1].userId).toBe(nareAdmin.id);

    expectNoMarhabaClientCalls();
    await expectNoMarhabaAuditRows();
  });

  it("rejects a USER connecting nare with 401 and never initializes a client", async () => {
    login(plainUser);
    const res = await accountsPOST(postAccounts({ action: "connect", account: "nare" }));
    expect(res.status).toBe(401);

    await sleep(250);
    expect(initializeWhatsAppMock).not.toHaveBeenCalled();
    expectNoMarhabaClientCalls();
    await expectNoMarhabaAuditRows();
  });
});
