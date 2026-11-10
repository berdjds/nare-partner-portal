/**
 * Phase 1 independent-review fixes: partners never validate or get notified,
 * D3 covers catalog rates / policies / imports / template markups, partner
 * permission grants are capped, /partner honours denies, WhatsApp send audit.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, seedFixtures, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "x" })) }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa" } })) }));

let prisma: PrismaClient, fx: Fixtures, workflow: typeof import("@/lib/travel/workflow");
let partner: any, ratesRoute: any, hotelsRoute: any, servicesRoute: any, policiesRoute: any, importsRoute: any, templatesRoute: any, assignableRoute: any, permsRoute: any, usersRoute: any;
const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null; };
const get = (url = "http://t/x") => new NextRequest(url);

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  partner = await prisma.user.create({ data: { email: "rp@t.io", name: "RP", password: "x", role: "PARTNER", agencyId: fx.agency.id } });
  ratesRoute = await import("@/app/api/travel/catalog/rates/route");
  hotelsRoute = await import("@/app/api/travel/catalog/hotels/route");
  servicesRoute = await import("@/app/api/travel/catalog/services/route");
  policiesRoute = await import("@/app/api/travel/policies/route");
  importsRoute = await import("@/app/api/travel/imports/route");
  templatesRoute = await import("@/app/api/travel/templates/route");
  assignableRoute = await import("@/app/api/travel/users/assignable/route");
  permsRoute = await import("@/app/api/permissions/route");
  usersRoute = await import("@/app/api/users/route");
  const tpl = await prisma.packageTemplate.create({ data: { code: "T-1", name: "T" } });
  await prisma.templateVersion.create({ data: { templateId: tpl.id, nights: 1, days: 2, daysJson: "[]", legacyMarkup: "0.17" } });
  await prisma.importBatch.create({ data: { sourceHash: "h", fileName: "f.xlsx", idempotencyKey: "k1" } });
});
beforeEach(() => as(null));

describe("M1: partners are never validators or recipients", () => {
  it("assignValidator refuses a PARTNER and the assignable list omits them", async () => {
    const { request } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await expect(workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: partner.id })).rejects.toThrow(/partner/i);
    as(fx.advisor);
    const list = await (await assignableRoute.GET()).json();
    expect(list.map((u: any) => u.id)).not.toContain(partner.id);
    expect(list.map((u: any) => u.id)).toContain(fx.validator.id);
  });
  it("turning a validator into a PARTNER deactivates their assignments", async () => {
    const v = await prisma.user.create({ data: { email: "tv@t.io", name: "TV", password: "x", role: "VALIDATOR" } });
    const { request } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: v.id });
    as(fx.admin);
    const res = await usersRoute.PATCH(new NextRequest("http://t/u", { method: "PATCH", body: JSON.stringify({ id: v.id, role: "PARTNER", agencyId: fx.agency.id }) }));
    expect(res.status).toBe(200);
    expect(await prisma.validationAssignment.count({ where: { validatorId: v.id, active: true } })).toBe(0);
    const list = await (await usersRoute.GET()).json();
    expect(list.find((u: any) => u.id === v.id).agencyId).toBe(fx.agency.id);
  });
});

describe("M2: supplier rates, markups and import costs need travel.internal.view", () => {
  it("ADVISOR sees catalog structure without amounts; ADMIN and VALIDATOR see them", async () => {
    for (const [who, sees] of [[fx.advisor, false], [fx.admin, true], [fx.validator, true]] as const) {
      as(who);
      const hotels = await (await hotelsRoute.GET(get())).json();
      const rate = hotels[0].rates[0];
      expect(rate.amount !== null, `${who.email} hotel rate amount`).toBe(sees);
      if (!sees) { expect(rate.hasRate).toBe(true); expect(rate.evidenceRef).toBeNull(); }
      const rates = await (await ratesRoute.GET(get())).json();
      expect(rates[0].amount !== null).toBe(sees);
      await servicesRoute.GET(get()); // shape smoke
      const pol = await (await policiesRoute.GET()).json();
      expect("rate" in pol[0]).toBe(sees);
      expect((await importsRoute.GET()).status).toBe(sees ? 200 : 403);
      const tpls = await (await templatesRoute.GET()).json();
      expect(tpls[0].versions[0].legacyMarkup !== null).toBe(sees);
    }
  });
});

describe("L3: partner grants are capped", () => {
  it("PUT /api/permissions rejects granting a non-ceiling key to a PARTNER but allows a deny", async () => {
    as(fx.admin);
    const put = (overrides: unknown[]) => permsRoute.PUT(new NextRequest("http://t/p", { method: "PUT", body: JSON.stringify({ userId: partner.id, overrides }) }));
    expect((await put([{ key: "travel.create", allowed: true }])).status).toBe(400);
    expect((await put([{ key: "travel.client_docs.download", allowed: false }])).status).toBe(200);
    await prisma.userPermission.deleteMany({ where: { userId: partner.id } });
  });
});

describe("L2: /partner honours permission denies", () => {
  it("a partner denied travel.access is sent to login", async () => {
    const p = await prisma.user.create({ data: { email: "dn@t.io", name: "DN", password: "x", role: "PARTNER", agencyId: fx.agency.id, permissions: { create: [{ key: "travel.access", allowed: false }] } } });
    as(p);
    const Page = (await import("@/app/partner/page")).default;
    await expect(Page()).rejects.toThrow("REDIRECT:/login");
  });
});
