/** Phase 3: client-visible vs internal notes, and template instantiation stamping rules. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, seedFixtures, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "x" })) }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa" } })) }));
vi.mock("@/lib/travel/pdf/render", () => ({ renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")) }));

let prisma: PrismaClient, fx: Fixtures, wf: typeof import("@/lib/travel/workflow");
let detailRoute: typeof import("@/app/api/travel/requests/[id]/route");
let instantiate: typeof import("@/app/api/travel/templates/[id]/instantiate/route");
let partner: any;
const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null; };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  wf = await import("@/lib/travel/workflow");
  detailRoute = await import("@/app/api/travel/requests/[id]/route");
  instantiate = await import("@/app/api/travel/templates/[id]/instantiate/route");
  fx = await seedFixtures(prisma);
  partner = await prisma.user.create({ data: { email: "cn@t.io", name: "CN", password: "x", role: "PARTNER", agencyId: fx.agency.id } });
});
beforeEach(() => as(null));

describe("client messages vs internal notes", () => {
  it("both are stored separately on create and on update; existing notes stay internal", async () => {
    const { request } = await wf.createRequest(actorOf(fx.advisor), { ...createRequestInput(fx.agency.id), notes: "internal only", clientNotes: "vegetarian group" } as any);
    const row = await prisma.travelRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(row).toMatchObject({ notes: "internal only", clientNotes: "vegetarian group" });
    await wf.updateDraft(actorOf(fx.advisor), request.id, row.revision, { clientNotes: "changed" } as any);
    const after = await prisma.travelRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after).toMatchObject({ notes: "internal only", clientNotes: "changed" });
  });
  it("a legacy request (no client notes) reads as null and notes remain staff-only", async () => {
    const { request } = await wf.createRequest(actorOf(fx.advisor), { ...createRequestInput(fx.agency.id), notes: "legacy" });
    expect((await prisma.travelRequest.findUniqueOrThrow({ where: { id: request.id } })).clientNotes).toBeNull();
  });
  it("the partner of the agency sees the client messages but never the internal notes", async () => {
    const { request } = await wf.createRequest(actorOf(fx.advisor), { ...createRequestInput(fx.agency.id), notes: "SECRET-INTERNAL", clientNotes: "window seats please" } as any);
    as(partner);
    const body = await (await detailRoute.GET(new NextRequest("http://t/r"), ctx(request.id))).json();
    expect(body.clientNotes).toBe("window seats please");
    expect(JSON.stringify(body)).not.toContain("SECRET-INTERNAL");
  });
  it("staff still receive both fields on the detail route", async () => {
    const { request } = await wf.createRequest(actorOf(fx.advisor), { ...createRequestInput(fx.agency.id), notes: "N", clientNotes: "C" } as any);
    as(fx.advisor);
    const body = await (await detailRoute.GET(new NextRequest("http://t/r"), ctx(request.id))).json();
    expect(body).toMatchObject({ notes: "N", clientNotes: "C" });
  });
  it("rejects over-long client messages like internal notes", async () => {
    await expect(wf.createRequest(actorOf(fx.advisor), { ...createRequestInput(fx.agency.id), clientNotes: "x".repeat(4001) } as any)).rejects.toBeTruthy();
  });
});

describe("instantiate from a template stamps the rules immediately", () => {
  it("returns the recalculation and leaves stamped lines (leader line inactive with no leaders)", async () => {
    const leader = await prisma.serviceProduct.create({ data: { name: "Leader meal", category: "TOUR_LEADER", basis: "PER_PERSON" } });
    const tour = await prisma.serviceProduct.create({ data: { name: "City tour", category: "TICKETS", basis: "PER_PERSON" } });
    const t = await prisma.packageTemplate.create({ data: { code: "INST-1", name: "Inst" } });
    const tv = await prisma.templateVersion.create({ data: { templateId: t.id, nights: 3, days: 4, daysJson: JSON.stringify([{ dayOffset: 0, services: [{ serviceProductId: tour.id, label: "City tour", quantity: 1 }, { serviceProductId: leader.id, label: "Leader meal", quantity: 1, rule: { appliesTo: ["leader"] } }] }]) } });
    as(fx.advisor);
    const res = await instantiate.POST(new NextRequest("http://t/i", { method: "POST", body: JSON.stringify({ ...createRequestInput(fx.agency.id), templateVersionId: tv.id, clientNotes: "hi" }) }), ctx(t.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.recalculation).toMatchObject({ governedLines: 2 });
    const lines = await prisma.serviceLine.findMany({ where: { versionId: body.versionId } });
    expect(lines.find((l) => l.label === "Leader meal")).toMatchObject({ origin: "TEMPLATE", ruleInactive: true });
    expect((await prisma.travelRequest.findUniqueOrThrow({ where: { id: body.request.id } })).clientNotes).toBe("hi");
  });
});
