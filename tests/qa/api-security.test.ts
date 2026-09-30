/**
 * QA: route-level security fixes — advisor data scoping and leak prevention.
 *
 * - GET /travel/requests/[id]: other advisor → 404 (IDOR); internal costing
 *   follows the int-lock rule — only actors holding travel.internal.view
 *   (granted via UserPermission here; D2 presets give it to ADMIN only) see
 *   the full costing blob, everyone else gets the redacted sell-side view;
 *   documents expose renderState only, never filePath.
 * - POST /travel/versions/[id]/calculate: owner / assigned validator / ADMIN
 *   only (404 otherwise); advisor policy overrides are refused (403) even
 *   with a travel.internal.view grant; the result is redacted without the key.
 * - POST /travel/requests/[id]/submit: the submitter is necessarily the owner
 *   or ADMIN; the engine result in the response follows the same int-lock
 *   redaction rule.
 * - GET /travel/documents/[id]: CLIENT docs restricted to owner / assigned
 *   validator / ADMIN (404 otherwise).
 * - GET /travel/settings: non-ADMIN sees only the active policy's currency.
 * - travelError: unknown errors return a generic 500 body.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let guard: typeof import("@/app/api/travel/guard");
let fx: Fixtures;
let advisor2: Fixtures["advisor"];
// Owner with an explicit travel.internal.view grant (D2: the ADVISOR preset
// does not carry it, so the fixture advisor gets the redacted view).
let advisorInternal: Fixtures["advisor"];

let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");
let calculateRoute: typeof import("@/app/api/travel/versions/[id]/calculate/route");
let submitRoute: typeof import("@/app/api/travel/requests/[id]/submit/route");
let documentsRoute: typeof import("@/app/api/travel/documents/[id]/route");
let settingsRoute: typeof import("@/app/api/travel/settings/route");

function session(user: { id: string; role: string; email: string; name: string | null } | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
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
  workflow = await import("@/lib/travel/workflow");
  guard = await import("@/app/api/travel/guard");
  fx = await seedFixtures(prisma);
  advisor2 = await prisma.user.create({
    data: { email: "sec-advisor2@test.io", name: "Advisor Two", password: "x", role: "ADVISOR" },
  });
  advisorInternal = await prisma.user.create({
    data: {
      email: "sec-advisor-internal@test.io",
      name: "Advisor Internal",
      password: "x",
      role: "ADVISOR",
      permissions: { create: [{ key: "travel.internal.view", allowed: true }] },
    },
  });
  // The full-costing validator assertions below expect the frozen data —
  // grant the key (D2: the VALIDATOR preset does not carry it). fx.validator2
  // stays ungranted for the redacted-view assertions.
  await prisma.userPermission.create({
    data: { userId: fx.validator.id, key: "travel.internal.view", allowed: true },
  });
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
  calculateRoute = await import("@/app/api/travel/versions/[id]/calculate/route");
  submitRoute = await import("@/app/api/travel/requests/[id]/submit/route");
  documentsRoute = await import("@/app/api/travel/documents/[id]/route");
  settingsRoute = await import("@/app/api/travel/settings/route");
});

beforeEach(() => session(null));

/** A submitted request owned by the given advisor with fx.validator assigned. */
async function submittedRequest(owner = fx.advisor) {
  const { request, version } = await workflow.createRequest(actorOf(owner), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(owner), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await workflow.assignValidator(actorOf(owner), request.id, { validatorId: fx.validator.id });
  const { hash } = await workflow.submit(actorOf(owner), request.id);
  return { request, version, hash };
}

describe("GET /travel/requests/[id] scoping", () => {
  it("another advisor gets 404, not 403 (existence is not disclosed)", async () => {
    const { request } = await submittedRequest();
    session(advisor2);
    const res = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(404);
  });

  it("the owner-advisor with a travel.internal.view grant sees the full costing blob incl. per-line net costs", async () => {
    const { request } = await submittedRequest(advisorInternal);
    session(advisorInternal);
    const res = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    const scenario = body.versions[0].scenarios[0];
    const parsed = JSON.parse(scenario.resultJson);
    expect(parsed.sell).toBe("342"); // 3 × 100 USD × 1.14 markup
    expect(parsed.totals.costQuote).toBe("300");
    expect(Array.isArray(parsed.lines)).toBe(true);
    // Per-version quote currency comes from the frozen snapshot display data.
    expect(body.versions[0].quoteCurrency).toBe("USD");
  });

  it("the owner-advisor WITHOUT a grant gets the redacted sell-side view (int-lock, D2)", async () => {
    // fx.advisor owns the request but the ADVISOR preset has no
    // travel.internal.view.
    const { request } = await submittedRequest();
    session(fx.advisor);
    const res = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    const scenario = body.versions[0].scenarios[0];
    const parsed = JSON.parse(scenario.resultJson);
    expect(parsed.sell).toBe("342");
    expect(parsed.totals).toBeUndefined();
    expect(parsed.lines).toBeUndefined();
    expect(parsed.profit).toBeUndefined();
    expect(parsed.margin).toBeUndefined();
    expect(parsed.trace).toBeUndefined();
    expect(scenario.traceRows).toBeUndefined();
    // Sell-side display data is still exposed.
    expect(body.versions[0].quoteCurrency).toBe("USD");
  });

  it("a validator with a travel.internal.view grant sees the full costing blob; without it the view is redacted", async () => {
    const { request } = await submittedRequest();

    // fx.validator was granted the key in beforeAll.
    session(fx.validator);
    const res = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = JSON.parse(body.versions[0].scenarios[0].resultJson);
    expect(parsed.totals.costQuote).toBe("300");
    expect(parsed.profit).toBeDefined();
    expect(parsed.trace.length).toBeGreaterThan(0);

    // fx.validator2 (VALIDATOR role, no grant) passes the record gate but gets
    // the redacted sell-side view.
    session(fx.validator2);
    const resR = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    expect(resR.status).toBe(200);
    const bodyR = await resR.json();
    const parsedR = JSON.parse(bodyR.versions[0].scenarios[0].resultJson);
    expect(parsedR.sell).toBe("342");
    expect(parsedR.totals).toBeUndefined();
    expect(parsedR.trace).toBeUndefined();
    expect(bodyR.versions[0].scenarios[0].traceRows).toBeUndefined();
  });

  it("document metadata exposes renderState and never the file path", async () => {
    const { request, version } = await submittedRequest();
    await prisma.quoteDocument.create({
      data: {
        versionId: version.id,
        snapshotHash: "0".repeat(64),
        kind: "CLIENT",
        templateVersion: "1",
        filePath: "FAILED:renderer exploded at /secret/path",
        sha256: "",
        idempotencyKey: `sec-${version.id}`,
      },
    });
    session(fx.advisor);
    const res = await requestByIdRoute.GET(req(`http://t/api/travel/requests/${request.id}`), { params: Promise.resolve({ id: request.id }) });
    const body = await res.json();
    const doc = body.versions[0].documents[0];
    expect(doc.renderState).toBe("FAILED");
    expect(doc.renderMessage).toBeTruthy();
    // The internal failure detail and path never leave the server.
    expect(JSON.stringify(body)).not.toContain("/secret/path");
    expect(JSON.stringify(body)).not.toContain("renderer exploded");
    expect(doc.filePath).toBeUndefined();
  });
});

describe("POST /travel/versions/[id]/calculate scoping", () => {
  it("allows owner / assigned validator / ADMIN; 404 for anyone else", async () => {
    const { version } = await submittedRequest();

    session(fx.validator2); // validator, but not assigned
    expect(
      (await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) })).status,
    ).toBe(404);

    session(advisor2);
    expect(
      (await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) })).status,
    ).toBe(404);

    session(fx.validator); // assigned; granted travel.internal.view in beforeAll
    const ok = await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) });
    expect(ok.status).toBe(200);
    const full = await ok.json();
    expect(full.scenarios[0].totals.costQuote).toBe("300");
    expect(full.quoteCurrency).toBe("USD");

    session(fx.admin);
    expect(
      (await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) })).status,
    ).toBe(200);
  });

  it("the owner-advisor with a grant gets the full result but still no policy override (the override rule is role-based)", async () => {
    const { version } = await submittedRequest(advisorInternal);

    session(advisorInternal);
    const res = await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quoteCurrency).toBe("USD");
    // The granted owner prices their own request: full costing, including line costs.
    expect(body.scenarios[0].totals.costQuote).toBe("300");
    expect(Array.isArray(body.scenarios[0].lines)).toBe(true);

    // travel.internal.view does not lift the ADVISOR policy-override ban.
    const withPolicy = await calculateRoute.POST(
      req(`http://t/api/travel/versions/${version.id}/calculate`, {
        method: "POST",
        body: { policy: { type: "MARKUP_ON_COST", rate: "0.5", roundingIncrement: "1" } },
      }),
      { params: Promise.resolve({ id: version.id }) },
    );
    expect(withPolicy.status).toBe(403);
  });

  it("the owner-advisor WITHOUT a grant gets the redacted sell-side preview (int-lock, D2)", async () => {
    const { version } = await submittedRequest();

    session(fx.advisor);
    const res = await calculateRoute.POST(req(`http://t/api/travel/versions/${version.id}/calculate`, { method: "POST" }), { params: Promise.resolve({ id: version.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quoteCurrency).toBe("USD");
    const scenario = body.scenarios[0];
    expect(scenario.sell).toBe("342");
    expect(scenario.totals).toBeUndefined();
    expect(scenario.lines).toBeUndefined();
    expect(scenario.profit).toBeUndefined();
    expect(scenario.trace).toBeUndefined();
    expect(scenario.traceRows).toBeUndefined();
  });
});

describe("POST /travel/requests/[id]/submit response", () => {
  // Builds an unsubmitted draft owned by `owner` with a validator assigned.
  async function draftRequest(owner: { id: string; role: string; name: string | null; email: string }) {
    const { request, version } = await workflow.createRequest(actorOf(owner), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(owner), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(owner), request.id, { validatorId: fx.validator.id });
    return { request };
  }

  it("the owner-advisor with a travel.internal.view grant gets versionId/hash plus the full engine result", async () => {
    const { request } = await draftRequest(advisorInternal);

    session(advisorInternal);
    const res = await submitRoute.POST(req(`http://t/api/travel/requests/${request.id}/submit`, { method: "POST" }), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.quoteCurrency).toBe("USD");
    expect(body.result.scenarios[0].totals.costQuote).toBe("300");
  });

  it("the owner-advisor WITHOUT a grant gets versionId/hash plus the redacted engine result (int-lock, D2)", async () => {
    const { request } = await draftRequest(fx.advisor);

    session(fx.advisor);
    const res = await submitRoute.POST(req(`http://t/api/travel/requests/${request.id}/submit`, { method: "POST" }), { params: Promise.resolve({ id: request.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.quoteCurrency).toBe("USD");
    const scenario = body.result.scenarios[0];
    expect(scenario.sell).toBe("342");
    expect(scenario.totals).toBeUndefined();
    expect(scenario.lines).toBeUndefined();
    expect(scenario.profit).toBeUndefined();
    expect(scenario.trace).toBeUndefined();
  });
});

describe("GET /travel/documents/[id] CLIENT scoping", () => {
  it("owner, assigned validator and ADMIN may read; others get 404", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-sec-docs-"));
    const file = path.join(dir, "doc.pdf");
    writeFileSync(file, "%PDF-1.4 sec");

    const { request, version } = await submittedRequest();
    const doc = await prisma.quoteDocument.create({
      data: {
        versionId: version.id,
        snapshotHash: "0".repeat(64),
        kind: "CLIENT",
        templateVersion: "1",
        filePath: file,
        sha256: "abc",
        idempotencyKey: `sec-doc-${version.id}`,
      },
    });

    session(advisor2);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${doc.id}`), { params: Promise.resolve({ id: doc.id }) })).status).toBe(404);

    session(fx.validator2); // not assigned to this request
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${doc.id}`), { params: Promise.resolve({ id: doc.id }) })).status).toBe(404);

    session(fx.validator); // the assigned validator
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${doc.id}`), { params: Promise.resolve({ id: doc.id }) })).status).toBe(200);

    session(fx.advisor); // owner
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${doc.id}`), { params: Promise.resolve({ id: doc.id }) })).status).toBe(200);

    session(fx.admin);
    expect((await documentsRoute.GET(req(`http://t/api/travel/documents/${doc.id}`), { params: Promise.resolve({ id: doc.id }) })).status).toBe(200);
    expect(request.packageCode).toBeTruthy();
  });
});

describe("GET /travel/settings policy exposure", () => {
  it("non-ADMIN roles receive only the active policy's quoteCurrency", async () => {
    session(fx.advisor);
    const res = await settingsRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.activePolicy).toEqual({ quoteCurrency: "USD" });
    expect(JSON.stringify(body.activePolicy)).not.toContain("rate");

    session(fx.admin);
    const full = await (await settingsRoute.GET()).json();
    expect(full.activePolicy.rate).toBe("0.14");
  });
});

describe("travelError", () => {
  it("unknown errors return a generic 500 body; WorkflowError keeps its message", async () => {
    const generic = guard.travelError(new Error("prisma: relation secret_table does not exist"), "[test]");
    expect(generic.status).toBe(500);
    expect(await generic.json()).toEqual({ error: "Internal error" });

    const { WorkflowError } = await import("@/lib/travel/workflow");
    const wf = guard.travelError(new WorkflowError("X", "clean message", 400), "[test]");
    expect(wf.status).toBe(400);
    expect((await wf.json()).error).toBe("clean message");
  });
});
