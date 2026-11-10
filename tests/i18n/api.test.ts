/** Phase 4: authorization and behaviour of the admin/public routes. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
let prisma: PrismaClient;
let tr: typeof import("@/app/api/admin/translations/route");
let ct: typeof import("@/app/api/admin/contact/route");
let pub: typeof import("@/app/api/admin/contact/publish/route");
let pubPublic: typeof import("@/app/api/public/contact/route");
let admin: any, advisor: any, partner: any, editor: any, product: any;
const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: 0 }, expires: "2099-01-01" } : null; };
const post = (route: any, body: unknown) => route.POST(new NextRequest("http://t/x", { method: "POST", body: JSON.stringify(body) }));
const put = (body: unknown) => ct.PUT(new NextRequest("http://t/x", { method: "PUT", body: JSON.stringify(body) }));

beforeAll(async () => {
  ensureSchema(); prisma = await getPrisma();
  tr = await import("@/app/api/admin/translations/route"); ct = await import("@/app/api/admin/contact/route");
  pub = await import("@/app/api/admin/contact/publish/route"); pubPublic = await import("@/app/api/public/contact/route");
  const agency = await prisma.agency.create({ data: { shortCode: "TRN", name: "T" } });
  const mk = (email: string, role: string, extra: any = {}) => prisma.user.create({ data: { email, name: email, password: "x", role, ...extra } });
  admin = await mk("a@t.io", "ADMIN"); advisor = await mk("v@t.io", "ADVISOR"); partner = await mk("p@t.io", "PARTNER", { agencyId: agency.id });
  editor = await mk("e@t.io", "ADVISOR", { permissions: { create: [{ key: "content.translate", allowed: true }] } });
  product = await prisma.serviceProduct.create({ data: { name: "Khor Virap visit", category: "TICKETS", basis: "PER_PERSON" } });
});
beforeEach(() => as(null));

describe("translations route", () => {
  const body = (o: object = {}) => ({ entity: "ServiceProduct", entityId: product.id, field: "name", locale: "hy", ...o });
  it("signed-out, advisor without keys and partner are refused", async () => {
    for (const u of [null, advisor, partner]) { as(u); expect((await tr.GET(new NextRequest("http://t/x?locale=hy"))).status).toBe(401); expect((await post(tr, { action: "draft", ...body(), text: "x" })).status).toBe(401); }
  });
  it("an editor (content.translate) can draft but not approve; the admin can approve; AI is disabled by default", async () => {
    as(editor);
    const d = await post(tr, { action: "draft", ...body(), text: "Խոր Վիրապի այց" });
    expect(d.status).toBe(201);
    const id = (await d.json()).id;
    expect((await post(tr, { action: "approve", id })).status).toBe(403);
    const ai = await post(tr, { action: "ai", ...body() });
    expect(ai.status).toBe(400);
    expect((await ai.json()).code).toBe("AI_DISABLED");
    as(admin);
    expect((await post(tr, { action: "approve", id })).status).toBe(200);
    const ov = await (await tr.GET(new NextRequest("http://t/x?locale=hy"))).json();
    expect(ov.aiAvailable).toBe(false);
    expect(ov.items.find((i: any) => i.entityId === product.id && i.field === "name").state).toBe("approved");
  });
  it("rejects translating anything that is not admin-managed content, and unknown actions", async () => {
    as(admin);
    expect((await post(tr, { action: "draft", ...body({ entity: "TravelRequest" }), text: "x" })).status).toBe(400);
    expect((await post(tr, { action: "nope" })).status).toBe(400);
    expect((await tr.GET(new NextRequest("http://t/x?locale=ar"))).status).toBe(400); // Arabic not enabled yet
  });
});

describe("contact routes", () => {
  it("only admin.settings can read or write; partner and advisor are refused", async () => {
    for (const u of [null, advisor, partner, editor]) {
      as(u);
      expect((await ct.GET(new NextRequest("http://t/x"))).status).toBe(401);
      expect((await put({ scope: "global", data: {} })).status).toBe(401);
      expect((await post(pub, { id: "x" })).status).toBe(401);
    }
  });
  it("draft then publish by an admin; invalid data is a 400 with a code; the public endpoint serves only what is visible and carries no secrets", async () => {
    as(admin);
    expect((await put({ scope: "global", data: { generalEmail: "bad" } })).status).toBe(400);
    const { DEFAULT_CONTACT } = await import("@/lib/contact/schema");
    const d = await put({ scope: "global", data: { ...DEFAULT_CONTACT, hours: "Mon-Fri 10:00-18:00", visibility: { ...DEFAULT_CONTACT.visibility, hours: true, map: true }, map: { lat: 40.1792, lng: 44.4991 } }, note: "hours" });
    expect(d.status).toBe(200);
    expect((await post(pub, { id: (await d.json()).id })).status).toBe(200);
    as(null); // public: no session needed
    const res = await pubPublic.GET();
    const c = await res.json();
    expect(c).toMatchObject({ generalEmail: "info@nare.am", hours: "Mon-Fri 10:00-18:00" });
    expect(c.mapEmbedUrl).toBe("https://www.google.com/maps?q=40.1792,44.4991&z=16&output=embed");
    expect(JSON.stringify(c)).not.toMatch(/key|secret|token|dataJson|createdById/i);
    expect(res.headers.get("Cache-Control")).toMatch(/max-age/);
  });
});
