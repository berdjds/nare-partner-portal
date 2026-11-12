/**
 * Phase 1 (R-SEC): partner isolation, D3 per-request internal access, direct-URL
 * authorization for every /api/travel route handler, and export audit logging.
 */
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })) }));
vi.mock("@/lib/travel/pdf/render", () => ({ renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")) }));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let fx: Fixtures;
let partnerA: any, partnerB: any, partnerNoAgency: any, partnerInactiveAgency: any;
let otherAgency: any, inactiveAgency: any;
let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");
let requestsRoute: typeof import("@/app/api/travel/requests/route");
let documentsRoute: typeof import("@/app/api/travel/documents/[id]/route");
let calculateRoute: typeof import("@/app/api/travel/versions/[id]/calculate/route");

function session(u: any) {
  sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null;
}
const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(url, { method: init?.method ?? "GET", ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id, versionId: id }) });

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  otherAgency = await prisma.agency.create({ data: { shortCode: "OTHR", name: "Other Agency" } });
  inactiveAgency = await prisma.agency.create({ data: { shortCode: "DEAD", name: "Dead Agency", active: false } });
  const mk = (email: string, agencyId: string | null) =>
    prisma.user.create({ data: { email, name: email, password: "x", role: "PARTNER", agencyId } as any });
  partnerA = await mk("pa@test.io", fx.agency.id);
  partnerB = await mk("pb@test.io", otherAgency.id);
  partnerNoAgency = await mk("pn@test.io", null);
  partnerInactiveAgency = await mk("pi@test.io", inactiveAgency.id);
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
  requestsRoute = await import("@/app/api/travel/requests/route");
  documentsRoute = await import("@/app/api/travel/documents/[id]/route");
  calculateRoute = await import("@/app/api/travel/versions/[id]/calculate/route");
});
beforeEach(() => session(null));

async function submittedRequest(agencyId = fx.agency.id) {
  const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(agencyId));
  await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await prisma.travelRequest.update({ where: { id: request.id }, data: { notes: "INTERNAL-SECRET-NOTE" } });
  await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
  await workflow.submit(actorOf(fx.advisor), request.id);
  return { request, version };
}
function addDoc(versionId: string, kind: "CLIENT" | "INTERNAL", issued: boolean) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "p1-doc-")), "d.pdf");
  writeFileSync(file, "%PDF-1.4 x");
  return prisma.quoteDocument.create({
    data: { versionId, snapshotHash: "0".repeat(64), kind, templateVersion: "1", filePath: file, sha256: "abc",
      idempotencyKey: `p1-${kind}-${versionId}-${issued}`, issuedAt: issued ? new Date() : null },
  });
}
const getDoc = (id: string) => documentsRoute.GET(req(`http://t/api/travel/documents/${id}`), ctx(id));
const getReq = (id: string) => requestByIdRoute.GET(req(`http://t/api/travel/requests/${id}`), ctx(id));

describe("PARTNER default-deny on every /api/travel route handler", () => {
  const ALLOWED = new Set(["requests/route.ts:GET", "requests/[id]/route.ts:GET", "documents/[id]/route.ts:GET"]);
  const root = path.resolve(__dirname, "../../app/api/travel");
  const files: string[] = [];
  (function walk(d: string) {
    for (const n of readdirSync(d)) { const p = path.join(d, n); statSync(p).isDirectory() ? walk(p) : n === "route.ts" && files.push(p); }
  })(root);

  it("finds the route files", () => expect(files.length).toBeGreaterThan(30));

  for (const f of files) {
    const rel = path.relative(root, f);
    it(`${rel}: PARTNER gets 401/403 on every method outside the allowlist`, async () => {
      const mod: any = await import(/* @vite-ignore */ f);
      session(partnerA);
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[m] !== "function" || ALLOWED.has(`${rel}:${m}`)) continue;
        const res: Response = await mod[m](req("http://t/api/x", m === "GET" ? undefined : { method: m, body: {} }), { params: Promise.resolve({ id: "nope", versionId: "nope" }) });
        expect([401, 403], `${rel} ${m} -> ${res.status}`).toContain(res.status);
      }
    });
  }
});

describe("PARTNER account validity", () => {
  it("no agency, or an inactive agency, means unauthenticated", async () => {
    for (const p of [partnerNoAgency, partnerInactiveAgency]) {
      session(p);
      expect((await requestsRoute.GET(req("http://t/api/travel/requests"))).status).toBe(401);
    }
  });
});

describe("PARTNER isolation and client-safe projection", () => {
  it("the list shows only the partner's own agency and never owner/validator identities", async () => {
    const a = await submittedRequest(fx.agency.id);
    const b = await submittedRequest(otherAgency.id);
    session(partnerA);
    const body = await (await requestsRoute.GET(req("http://t/api/travel/requests"))).json();
    const ids = body.map((r: any) => r.id);
    expect(ids).toContain(a.request.id);
    expect(ids).not.toContain(b.request.id);
    expect(JSON.stringify(body)).not.toMatch(/advisor@test|validator@test/);
  });

  it("another agency's request is 404 (existence not disclosed)", async () => {
    const b = await submittedRequest(otherAgency.id);
    session(partnerA);
    expect((await getReq(b.request.id)).status).toBe(404);
  });

  it("own request detail carries no costing, notes, workflow, assignments or identities", async () => {
    const a = await submittedRequest();
    session(partnerA);
    const res = await getReq(a.request.id);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    for (const forbidden of ["INTERNAL-SECRET-NOTE", "costQuote", "unitRate", "overrideRate", "sourceRef", "margin", "advisor@test", "validator@test", "resultJson", "inputsJson", "rateOverrides"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("with an ISSUED client quotation: sell price and itinerary only, never a cost or margin key; unissued versions are invisible", async () => {
    const a = await submittedRequest();
    session(partnerA);
    const before = await (await getReq(a.request.id)).json();
    expect(before.versions).toEqual([]); // nothing issued yet: no workflow state leaks
    await addDoc(a.version.id, "CLIENT", true);
    const res = await getReq(a.request.id);
    const body = await res.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].scenarios[0]).toHaveProperty("sell");
    expect(body.versions[0]).not.toHaveProperty("status"); // version workflow state is internal
    const text = JSON.stringify(body);
    for (const k of ["costQuote", "profit", "margin", "markup", "unitRate", "totals", "traceRows", "lines", "issues"]) {
      expect(text, k).not.toContain(`"${k}"`);
    }
  });

  it("partners cannot call calculate, even for their own request", async () => {
    const a = await submittedRequest();
    session(partnerA);
    expect((await calculateRoute.POST(req("http://t/x", { method: "POST", body: {} }), ctx(a.version.id))).status).toBeOneOf([401, 403]);
  });
});

describe("PARTNER downloads", () => {
  it("only an issued CLIENT document of their own agency", async () => {
    const a = await submittedRequest();
    const b = await submittedRequest(otherAgency.id);
    const issued = await addDoc(a.version.id, "CLIENT", true);
    const draft = await addDoc(a.version.id, "CLIENT", false);
    const internal = await addDoc(a.version.id, "INTERNAL", true);
    const foreign = await addDoc(b.version.id, "CLIENT", true);
    session(partnerA);
    expect((await getDoc(issued.id)).status).toBe(200);
    expect((await getDoc(draft.id)).status).toBe(404);
    expect([403, 404]).toContain((await getDoc(internal.id)).status);
    expect((await getDoc(foreign.id)).status).toBe(404);
    session(partnerB);
    expect((await getDoc(issued.id)).status).toBe(404);
  });
});

describe("D3: internal calculation only for ADMIN or the request's assigned validator", () => {
  it("an unassigned validator holding the key gets the redacted view and no INTERNAL document", async () => {
    const a = await submittedRequest(); // fx.validator assigned, fx.validator2 not
    const internal = await addDoc(a.version.id, "INTERNAL", true);
    session(fx.validator2);
    const res = await getReq(a.request.id);
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("costQuote");
    expect(text).not.toContain("traceRows");
    expect(text).not.toContain('"kind":"INTERNAL"');
    expect([403, 404]).toContain((await getDoc(internal.id)).status);
  });

  it("the assigned validator and ADMIN receive the INTERNAL document and the full costing", async () => {
    const a = await submittedRequest();
    const internal = await addDoc(a.version.id, "INTERNAL", true);
    for (const u of [fx.validator, fx.admin]) {
      session(u);
      expect((await getDoc(internal.id)).status).toBe(200);
      expect(JSON.stringify(await (await getReq(a.request.id)).json())).toContain("costQuote");
    }
  });
});

describe("export audit", () => {
  it("records allowed and denied downloads with actor, document and outcome", async () => {
    const a = await submittedRequest();
    const doc = await addDoc(a.version.id, "CLIENT", true);
    const internal = await addDoc(a.version.id, "INTERNAL", true);
    session(partnerA); await getDoc(doc.id); await getDoc(internal.id);
    const logs = await prisma.log.findMany({ where: { action: "travel.export" } });
    const details = logs.map((l) => JSON.parse(l.details ?? "{}"));
    expect(details.some((d) => d.documentId === doc.id && d.outcome === "allowed" && d.actorId === partnerA.id)).toBe(true);
    expect(details.some((d) => d.documentId === internal.id && d.outcome === "denied")).toBe(true);
    expect(JSON.stringify(details)).not.toContain("filePath");
    expect(JSON.stringify(details)).not.toContain(doc.filePath); // the real path value never reaches the log
  });
});
