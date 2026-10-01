/**
 * W3 (wa-multi) dashboard page gating tests: /dashboard shows each user
 * exactly the WhatsApp accounts whose per-account view permission they hold
 * (marhaba → whatsapp.inbox.view, nare → whatsapp.nare.view), resolved from
 * the current database row, and passes that server-computed list to
 * ChatDashboard (which feeds the account switcher). Users who can view no
 * account are redirected to /travel; anonymous, inactive or unknown sessions
 * go to /login.
 *
 * Only getServerSession is mocked; the page, the access policy, the
 * permission resolution and the default-account registry run against a
 * throwaway SQLite database (ensureDefaultAccounts() inside the page creates
 * the marhaba/nare rows). The ChatDashboard element is never rendered — its
 * props are inspected directly.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

let prisma: PrismaClient;
let DashboardPage: typeof import("@/app/dashboard/page").default;

type TestUser = { id: string; email: string; name: string | null; role: string };

let admin: TestUser;
let plainUser: TestUser;
let advisor: TestUser;
let inactiveUser: TestUser;
let nareViewer: TestUser;
let nareSender: TestUser;
let nareAdvisor: TestUser;

/** Session the way NextAuth returns it. */
function login(user: TestUser | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

/** Runs the page and returns the redirect target, or null when it rendered. */
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

const MARHABA_ENTRY = {
  key: "marhaba",
  displayName: "Marhaba Armenia",
  canSend: true,
  canAdmin: false,
};

const NARE_ENTRY = {
  key: "nare",
  displayName: "Nare Travel and Tours",
  canSend: false,
  canAdmin: false,
};

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  DashboardPage = (await import("@/app/dashboard/page")).default;

  admin = await prisma.user.create({
    data: { email: "dash-admin@test.io", name: "Admin", password: "x", role: "ADMIN" },
  });
  plainUser = await prisma.user.create({
    data: { email: "dash-user@test.io", name: "User", password: "x", role: "USER" },
  });
  advisor = await prisma.user.create({
    data: { email: "dash-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" },
  });
  inactiveUser = await prisma.user.create({
    data: { email: "dash-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
  });
  nareViewer = await prisma.user.create({
    data: { email: "dash-nare-viewer@test.io", name: "Nare Viewer", password: "x", role: "USER" },
  });
  await prisma.userPermission.create({
    data: { userId: nareViewer.id, key: "whatsapp.nare.view", allowed: true },
  });
  nareSender = await prisma.user.create({
    data: { email: "dash-nare-sender@test.io", name: "Nare Sender", password: "x", role: "USER" },
  });
  await prisma.userPermission.createMany({
    data: [
      { userId: nareSender.id, key: "whatsapp.nare.view", allowed: true },
      { userId: nareSender.id, key: "whatsapp.nare.send", allowed: true },
    ],
  });
  nareAdvisor = await prisma.user.create({
    data: { email: "dash-nare-advisor@test.io", name: "Nare Advisor", password: "x", role: "ADVISOR" },
  });
  await prisma.userPermission.create({
    data: { userId: nareAdvisor.id, key: "whatsapp.nare.view", allowed: true },
  });
});

beforeEach(() => {
  login(null);
});

describe("DashboardPage W3 account gating", () => {
  it("redirects anonymous sessions to /login", async () => {
    expect(await redirectTarget(() => DashboardPage())).toBe("/login");
  });

  it("redirects inactive users to /login", async () => {
    login(inactiveUser);
    expect(await redirectTarget(() => DashboardPage())).toBe("/login");
  });

  it("gives a plain USER only the marhaba account", async () => {
    login(plainUser);
    const el: any = await DashboardPage();
    expect(el.props.isAdminRole).toBe(false);
    expect(el.props.accounts).toEqual([MARHABA_ENTRY]);
  });

  it("gives a USER with whatsapp.nare.view both accounts, nare read-only", async () => {
    login(nareViewer);
    const el: any = await DashboardPage();
    expect(el.props.accounts).toEqual([MARHABA_ENTRY, NARE_ENTRY]);
  });

  it("lets a USER with whatsapp.nare.send send from nare without administering it", async () => {
    login(nareSender);
    const el: any = await DashboardPage();
    expect(el.props.accounts).toEqual([MARHABA_ENTRY, { ...NARE_ENTRY, canSend: true }]);
  });

  it("renders for an ADVISOR granted whatsapp.nare.view, listing only nare", async () => {
    login(nareAdvisor);
    const el: any = await DashboardPage();
    expect(el.props.isAdminRole).toBe(false);
    expect(el.props.accounts).toEqual([NARE_ENTRY]);
  });

  it("redirects an ADVISOR without any whatsapp grants to /travel", async () => {
    login(advisor);
    expect(await redirectTarget(() => DashboardPage())).toBe("/travel");
  });

  it("gives an ADMIN both accounts with send and admin rights", async () => {
    login(admin);
    const el: any = await DashboardPage();
    expect(el.props.isAdminRole).toBe(true);
    expect(el.props.accounts).toEqual([
      { ...MARHABA_ENTRY, canAdmin: true },
      { ...NARE_ENTRY, canSend: true, canAdmin: true },
    ]);
  });
});
