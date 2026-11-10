/**
 * Phase 2 integration: deterministic template recalculation against the database,
 * concurrency/stale revisions, audit, manual-edit protection, template switch, date
 * change, editor round-trip, authorization and the advisor price-guidance leak guard.
 */
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

let prisma: PrismaClient, fx: Fixtures, wf: typeof import("@/lib/travel/workflow"), resolve: typeof import("@/lib/travel/resolve");
let recalcRoute: typeof import("@/app/api/travel/requests/[id]/recalculate/route");
let requestRoute: typeof import("@/app/api/travel/requests/[id]/route");
let ticket: any, leaderMeal: any, groupTour: any, extra: any;
let tplA: any, tplB: any, partner: any, otherAdvisor: any;

const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null; };
const post = (id: string, body: unknown) => recalcRoute.POST(new NextRequest("http://t/r", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) => requestRoute.PATCH(new NextRequest("http://t/r", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  wf = await import("@/lib/travel/workflow");
  resolve = await import("@/lib/travel/resolve");
  recalcRoute = await import("@/app/api/travel/requests/[id]/recalculate/route");
  requestRoute = await import("@/app/api/travel/requests/[id]/route");
  fx = await seedFixtures(prisma);
  otherAdvisor = await prisma.user.create({ data: { email: "oa@t.io", name: "OA", password: "x", role: "ADVISOR" } });
  partner = await prisma.user.create({ data: { email: "rp2@t.io", name: "RP", password: "x", role: "PARTNER", agencyId: fx.agency.id } });
  const mk = async (name: string, category: string, amount: string) => {
    const p = await prisma.serviceProduct.create({ data: { name, category, basis: "PER_PERSON" } });
    await prisma.rateVersion.create({ data: { productType: "SERVICE", serviceProductId: p.id, amount, currency: "USD", status: "VERIFIED", evidenceRef: "T!1" } });
    return p;
  };
  ticket = await mk("Museum ticket", "TICKETS", "10");
  leaderMeal = await mk("Leader meal", "TOUR_LEADER", "7");
  groupTour = await mk("Group tour", "TICKETS", "20");
  extra = await mk("Winery", "TICKETS", "5");
  const tpl = async (code: string, days: unknown) => {
    const t = await prisma.packageTemplate.create({ data: { code, name: code } });
    return prisma.templateVersion.create({ data: { templateId: t.id, nights: 3, days: 4, daysJson: JSON.stringify(days) } });
  };
  tplA = await tpl("TPL-A", [
    { dayOffset: 0, services: [{ serviceProductId: ticket.id, label: "Museum ticket", quantity: 1 }, { serviceProductId: leaderMeal.id, label: "Leader meal", quantity: 1, rule: { appliesTo: ["leader"] } }] },
    { dayOffset: 1, services: [{ serviceProductId: groupTour.id, label: "Group tour", quantity: 1, rule: { weekdays: [3, 5, 7], minParticipants: 4 } }] },
  ]);
  tplB = await tpl("TPL-B", [{ dayOffset: 0, services: [{ serviceProductId: extra.id, label: "Winery", quantity: 1 }] }]);
});
beforeEach(() => as(null));

async function newRequest(opts: { owner?: any; templateVersionId?: string | null; travelers?: any } = {}) {
  const owner = opts.owner ?? fx.advisor;
  const { request, version } = await wf.createRequest(actorOf(owner), { ...createRequestInput(fx.agency.id), ...(opts.travelers ? { travelers: opts.travelers } : {}) });
  const tv = opts.templateVersionId === undefined ? tplA.id : opts.templateVersionId;
  if (tv) await prisma.quoteVersion.update({ where: { id: version.id }, data: { templateVersionId: tv } });
  return { request, version };
}
const rev = async (id: string) => (await prisma.travelRequest.findUniqueOrThrow({ where: { id } })).revision;
const lines = (versionId: string) => prisma.serviceLine.findMany({ where: { versionId, serviceProductId: { not: null } }, orderBy: { label: "asc" } });
const byLabel = (ls: any[], label: string) => ls.find((l) => l.label === label);

describe("recalculateFromTemplate", () => {
  it("builds the template content, stamps lines, deactivates the leader line with no leaders, audits once", async () => {
    const { request, version } = await newRequest();
    const out = await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    expect(out.changed).toBe(true);
    const ls = await lines(version.id);
    expect(ls.map((l) => l.label)).toEqual(["Group tour", "Leader meal", "Museum ticket"]);
    expect(byLabel(ls, "Leader meal")).toMatchObject({ origin: "TEMPLATE", participants: 0, ruleInactive: true });
    expect(byLabel(ls, "Museum ticket")).toMatchObject({ origin: "TEMPLATE", participants: null, ruleInactive: false });
    const days = await prisma.itineraryDay.findMany({ where: { versionId: version.id }, orderBy: { dayOffset: "asc" } });
    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    const logs = await prisma.log.findMany({ where: { action: "travel.recalc" } });
    const mine = logs.map((l) => JSON.parse(l.details!)).filter((d) => d.requestId === request.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ templateVersionId: tplA.id, daysChanged: true });
  });

  it("is idempotent: the second run changes nothing, keeps the revision and writes no audit row", async () => {
    const { request } = await newRequest();
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    const r1 = await rev(request.id);
    const again = await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: r1 });
    expect(again).toMatchObject({ changed: false, daysChanged: false, linesUpdated: 0, revision: r1 });
    expect(await rev(request.id)).toBe(r1);
    const logs = (await prisma.log.findMany({ where: { action: "travel.recalc" } })).map((l) => JSON.parse(l.details!)).filter((d) => d.requestId === request.id);
    expect(logs).toHaveLength(1);
  });

  it("a leader added through the PATCH route activates the leader line and the price follows server-side", async () => {
    const { request, version } = await newRequest();
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    const price = async () => {
      const input = await resolve.buildEngineInputForVersion(version.id);
      const leader = input.scenarios[0].services.find((s: any) => s.label === "Leader meal")!;
      return { leader, included: leader.includedElsewhere };
    };
    expect((await price()).included).toBe(true); // inactive: not charged
    as(fx.advisor);
    const res = await patch(request.id, { expectedRevision: await rev(request.id), patch: { travelers: { adults: 2, children: 0, infants: 0, paying: 2, complimentary: 0, leaders: 1, staff: 0 } } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recalculation).toMatchObject({ changed: true, linesUpdated: 1 });
    const { leader, included } = await price();
    expect(included).toBe(false);
    expect(leader.participants).toBe(1);
  });

  it("zero travellers: lines for absent categories are inactive and nothing throws", async () => {
    const { request, version } = await newRequest({ travelers: { adults: 0, children: 0, infants: 0, paying: 0, complimentary: 0, leaders: 0, staff: 0 } });
    const out = await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    expect(out.changed).toBe(true);
    expect(byLabel(await lines(version.id), "Leader meal").ruleInactive).toBe(true);
  });

  it("stale revision is a 409 and writes nothing; two concurrent runs never both win silently", async () => {
    const { request, version } = await newRequest();
    const r0 = await rev(request.id);
    await expect(wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: r0 + 5 })).rejects.toMatchObject({ code: "CONFLICT", httpStatus: 409 });
    expect(await lines(version.id)).toHaveLength(0);
    const settled = await Promise.allSettled([
      wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: r0 }),
      wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: r0 }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const b of bad) expect(b.reason).toMatchObject({ code: "CONFLICT" });
    expect((await lines(version.id)).map((l) => l.label)).toEqual(["Group tour", "Leader meal", "Museum ticket"]); // no duplicates
  });

  it("a hand-edited line is kept and reported; a manual line is never touched", async () => {
    const { request, version } = await newRequest({ travelers: { adults: 2, children: 0, infants: 0, paying: 2, complimentary: 0, leaders: 1, staff: 0 } });
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    const manual = await prisma.serviceLine.create({ data: { versionId: version.id, category: "OTHER", label: "Manual extra", basis: "GROUP", quantity: "1", participants: 3 } });
    await prisma.serviceLine.updateMany({ where: { versionId: version.id, label: "Leader meal" }, data: { participants: 9 } });
    as(fx.advisor);
    const res = await patch(request.id, { expectedRevision: await rev(request.id), patch: { travelers: { adults: 2, children: 0, infants: 0, paying: 2, complimentary: 0, leaders: 2, staff: 0 } } });
    const body = await res.json();
    expect(body.recalculation.conflicts.map((c: any) => c.code)).toContain("MANUAL_OVERRIDE_KEPT");
    const ls = await lines(version.id);
    expect(byLabel(ls, "Leader meal").participants).toBe(9);
    expect((await prisma.serviceLine.findUniqueOrThrow({ where: { id: manual.id } })).participants).toBe(3);
  });

  it("date change re-dates the itinerary and the lines, and flags a non-departure weekday", async () => {
    const { request, version } = await newRequest({ travelers: { adults: 4, children: 0, infants: 0, paying: 4, complimentary: 0, leaders: 0, staff: 0 } });
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    expect(byLabel(await lines(version.id), "Group tour").reviewFlag).toBeNull(); // Fri 2026-10-02, 4 guests: allowed
    as(fx.advisor);
    const res = await patch(request.id, { expectedRevision: await rev(request.id), patch: { startDate: "2026-10-05", endDate: "2026-10-08" } });
    const body = await res.json();
    expect(body.recalculation.conflicts.map((c: any) => c.code)).toContain("WEEKDAY_UNAVAILABLE"); // Tue 2026-10-06
    const days = await prisma.itineraryDay.findMany({ where: { versionId: version.id }, orderBy: { dayOffset: "asc" } });
    expect(days.map((d) => d.date)).toEqual(["2026-10-05", "2026-10-06"]);
    expect(byLabel(await lines(version.id), "Group tour")).toMatchObject({ date: "2026-10-06", reviewFlag: "WEEKDAY_UNAVAILABLE" });
  });

  it("template switch replaces template items, keeps manual ones, restamps", async () => {
    const { request, version } = await newRequest();
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    const out = await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id), templateVersionId: tplB.id });
    expect(out.templateVersionId).toBe(tplB.id);
    expect((await lines(version.id)).map((l) => l.label)).toEqual(["Winery"]);
    expect((await prisma.quoteVersion.findUniqueOrThrow({ where: { id: version.id } })).templateVersionId).toBe(tplB.id);
  });

  it("the editor round trip (service lines re-saved without provenance) keeps the template stamp", async () => {
    const { request, version } = await newRequest();
    await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    const ls = await lines(version.id);
    await wf.saveVersionContent(actorOf(fx.advisor), version.id, {
      expectedRevision: await rev(request.id),
      serviceLines: ls.map((l) => ({ category: l.category as any, label: l.label, basis: l.basis as any, currency: l.currency, unitRate: l.unitRate, quantity: l.quantity, participants: l.participants, capacity: l.capacity, includedElsewhere: l.includedElsewhere, isStaffCost: l.isStaffCost, serviceProductId: l.serviceProductId, date: l.date, vehicleTypeId: l.vehicleTypeId })),
    });
    const after = await lines(version.id);
    expect(byLabel(after, "Leader meal")).toMatchObject({ origin: "TEMPLATE", ruleInactive: true });
    const again = await wf.recalculateFromTemplate(actorOf(fx.advisor), request.id, { expectedRevision: await rev(request.id) });
    expect(again.changed).toBe(false);
  });

  it("refuses a version without a template, a non-owner advisor, and non-editable versions", async () => {
    const none = await newRequest({ templateVersionId: null });
    await expect(wf.recalculateFromTemplate(actorOf(fx.advisor), none.request.id, { expectedRevision: await rev(none.request.id) })).rejects.toMatchObject({ code: "NO_TEMPLATE" });
    const mine = await newRequest();
    await expect(wf.recalculateFromTemplate(actorOf(otherAdvisor), mine.request.id, { expectedRevision: await rev(mine.request.id) })).rejects.toMatchObject({ httpStatus: 403 });
    await prisma.quoteVersion.update({ where: { id: mine.version.id }, data: { status: "ISSUED" } });
    await expect(wf.recalculateFromTemplate(actorOf(fx.advisor), mine.request.id, { expectedRevision: await rev(mine.request.id) })).rejects.toBeTruthy();
  });
});

describe("recalculate route: authorization and the advisor guidance leak guard", () => {
  it("partner and signed-out are refused; a non-owner advisor gets 403", async () => {
    const { request } = await newRequest();
    const body = { expectedRevision: await rev(request.id) };
    as(null); expect((await post(request.id, body)).status).toBe(401);
    as(partner); expect([401, 403]).toContain((await post(request.id, body)).status);
    as(otherAdvisor); expect((await post(request.id, body)).status).toBe(403);
  });

  it("an advisor receives a sell-side figure only: no cost, rate, margin or markup keys or values anywhere in the payload", async () => {
    const { request, version } = await newRequest();
    await prisma.scenario.deleteMany({ where: { versionId: version.id } });
    as(fx.advisor);
    const res = await post(request.id, { expectedRevision: await rev(request.id) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.guidance).toBeTruthy();
    const keys = new Set<string>();
    (function walk(v: unknown) { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } })(body);
    for (const bad of ["unitRate", "overrideRate", "costQuote", "costAmd", "profit", "margin", "markup", "totals", "lines", "trace", "traceRows", "rate", "feeFraction", "minProfit", "evidenceRef", "sourceRef", "amount", "message"]) {
      expect(keys.has(bad), `leaked key ${bad}`).toBe(false);
    }
    const text = JSON.stringify(body);
    for (const secret of ["0.14", "Tour Calculator", "T!1", "MARKUP_ON_COST"]) expect(text).not.toContain(secret);
  });

  it("guidance with a healthy scenario returns sell and per-person figures and issue codes only", async () => {
    const { request, version } = await newRequest();
    const { saveContent, scenarioContent } = await import("../workflow/fixtures");
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    as(fx.advisor);
    const body = await (await post(request.id, { expectedRevision: await rev(request.id) })).json();
    expect(body.guidance.available).toBe(true);
    const sc = body.guidance.scenarios[0];
    expect(Object.keys(sc).sort()).toEqual(["days", "issues", "label", "nights", "perPayingPerson", "ref", "sell", "valid"]);
    for (const i of sc.issues) expect(Object.keys(i).sort()).toEqual(["code", "severity"]);
  });
});
