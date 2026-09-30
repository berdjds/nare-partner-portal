/**
 * int-lock: internal-cost redaction is permission-based (travel.internal.view),
 * not role-based. Under D2 only ADMIN's preset carries the key, so owners and
 * validators get the redacted sell-side view unless granted the key via a
 * UserPermission override.
 *
 * Pins, for GET /api/travel/requests/[id] and POST /api/travel/versions/[id]/calculate:
 * - ADMIN: full costing (totals/profit/margin/trace/lines), traceRows, and
 *   INTERNAL document metadata in the documents list.
 * - ADVISOR request owner WITHOUT a grant: scenario resultJson reduced to the
 *   sell-side shape (sell/perPayingPerson/ref/label/valid/issues/nights/days —
 *   no costQuote/margin/profit/trace/lines), no traceRows, INTERNAL documents
 *   absent from the documents list, CLIENT documents still listed.
 * - ADVISOR request owner WITH a travel.internal.view grant: full costing,
 *   traceRows, and INTERNAL document metadata.
 */

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
let fx: Fixtures;

let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");
let calculateRoute: typeof import("@/app/api/travel/versions/[id]/calculate/route");

type Userish = { id: string; role: string; name: string | null; email: string };

function session(user: Userish | null) {
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

const getDetail = (id: string) =>
  requestByIdRoute.GET(req(`http://t/api/travel/requests/${id}`), { params: Promise.resolve({ id }) });
const postCalculate = (versionId: string) =>
  calculateRoute.POST(req(`http://t/api/travel/versions/${versionId}/calculate`, { method: "POST", body: {} }), {
    params: Promise.resolve({ id: versionId }),
  });

/** A user with per-user overrides (UserPermission rows), unique email per call site. */
function createUser(role: string, email: string, overrides: { key: string; allowed: boolean }[] = []) {
  return prisma.user.create({
    data: { email, name: email, password: "x", role, permissions: { create: overrides } },
  });
}

/**
 * A submitted request owned by `owner`, with fx.validator assigned. submit()
 * auto-creates the INTERNAL costing document (filePath PENDING); a CLIENT
 * document is added so both kinds are present in the documents list.
 */
async function submittedRequestWithDocs(owner: Userish) {
  const { request, version } = await workflow.createRequest(actorOf(owner), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(owner), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  await workflow.assignValidator(actorOf(owner), request.id, { validatorId: fx.validator.id });
  await workflow.submit(actorOf(owner), request.id);
  await prisma.quoteDocument.create({
    data: {
      versionId: version.id,
      snapshotHash: "0".repeat(64),
      kind: "CLIENT",
      templateVersion: "1",
      filePath: `/tmp/int-lock-client-${version.id}.pdf`,
      sha256: "abc",
      idempotencyKey: `int-lock-client-${version.id}`,
    },
  });
  return { request, version };
}

const SELL_SIDE_KEYS = ["days", "issues", "label", "nights", "perPayingPerson", "ref", "sell", "valid"];

type ContentInput = Omit<import("@/lib/travel/workflow").SaveVersionContentInput, "expectedRevision">;

/**
 * Scenario content carrying internal costing on the STORED rows (not just the
 * engine result): a service line with net rate, override rate + reason and
 * rate provenance, and a stay with a per-roomType rate override.
 */
function contentWithInternalFields(): ContentInput {
  const base = scenarioContent(fx.hotel.id, fx.hotel.name);
  return {
    scenarios: base.scenarios.map((sc) => ({
      ...sc,
      stays: sc.stays.map((st) => ({
        ...st,
        rateOverrides: { DBL: { rate: "90", reason: "Negotiated corporate rate" } },
      })),
    })),
    serviceLines: [
      {
        scenarioKey: "A",
        category: "TICKETS",
        label: "Museum tickets",
        basis: "PER_PERSON",
        currency: "USD",
        unitRate: "25",
        quantity: "1",
        participants: 2,
        includedElsewhere: false,
        isStaffCost: false,
        overrideRate: "20",
        overrideReason: "Group discount negotiated with the supplier",
        sourceRef: "Tour Calculator!C58",
      },
    ],
  };
}

/**
 * A SUBMITTED request (version no longer editable) with internal fields on
 * its service line and stay, validated by the ungranted fx.validator2.
 */
async function submittedRequestWithInternalFields(owner: Userish) {
  const { request, version } = await workflow.createRequest(actorOf(owner), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(owner), request.id, version.id, contentWithInternalFields());
  await workflow.assignValidator(actorOf(owner), request.id, { validatorId: fx.validator2.id });
  await workflow.submit(actorOf(owner), request.id);
  return { request, version };
}

const INTERNAL_LINE_KEYS = ["unitRate", "overrideRate", "overrideReason", "overrideById", "sourceRef"];

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
  calculateRoute = await import("@/app/api/travel/versions/[id]/calculate/route");
});

beforeEach(() => session(null));

describe("ADMIN (preset carries travel.internal.view): full costing everywhere", () => {
  it("GET detail: full costing, traceRows, and INTERNAL document metadata", async () => {
    const { request } = await submittedRequestWithDocs(fx.advisor);
    session(fx.admin);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const scenario = body.versions[0].scenarios[0];
    const parsed = JSON.parse(scenario.resultJson);
    expect(parsed.totals.costQuote).toBe("300"); // 3 nights × 100 USD
    expect(parsed.sell).toBe("342"); // × 1.14 markup
    expect(parsed.profit).toBeDefined();
    expect(parsed.margin).toBeDefined();
    expect(parsed.trace.length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(Array.isArray(scenario.traceRows)).toBe(true);
    expect(scenario.traceRows.length).toBeGreaterThan(0);

    // Both document kinds are listed; metadata only, never the file path.
    const kinds = body.versions[0].documents.map((d: any) => d.kind).sort();
    expect(kinds).toEqual(["CLIENT", "INTERNAL"]);
    for (const doc of body.versions[0].documents) {
      expect(doc.renderState).toBeDefined();
      expect(doc.filePath).toBeUndefined();
    }
  });

  it("calculate: full engine result with traceRows", async () => {
    const { version } = await submittedRequestWithDocs(fx.advisor);
    session(fx.admin);
    const res = await postCalculate(version.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenarios[0].totals.costQuote).toBe("300");
    expect(Array.isArray(body.scenarios[0].traceRows)).toBe(true);
    expect(body.quoteCurrency).toBe("USD");
  });
});

describe("ADVISOR owner WITHOUT a grant: redacted sell-side view (int-lock, D2)", () => {
  it("GET detail: costing stripped, no traceRows, INTERNAL documents hidden", async () => {
    const { request } = await submittedRequestWithDocs(fx.advisor);
    session(fx.advisor);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const scenario = body.versions[0].scenarios[0];
    const parsed = JSON.parse(scenario.resultJson);
    expect(Object.keys(parsed).sort()).toEqual(SELL_SIDE_KEYS);
    expect(parsed.sell).toBe("342");
    expect(scenario.traceRows).toBeUndefined();

    // INTERNAL documents are absent even as list metadata; CLIENT stays.
    const kinds = body.versions[0].documents.map((d: any) => d.kind);
    expect(kinds).toEqual(["CLIENT"]);
    expect(body.versions[0].documents[0].renderState).toBe("READY");
  });

  it("calculate: redacted scenarios, no traceRows", async () => {
    const { version } = await submittedRequestWithDocs(fx.advisor);
    session(fx.advisor);
    const res = await postCalculate(version.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.scenarios[0]).sort()).toEqual(SELL_SIDE_KEYS);
    expect(body.scenarios[0].sell).toBe("342");
    expect(body.scenarios[0].traceRows).toBeUndefined();
    expect(body.quoteCurrency).toBe("USD");
  });
});

describe("ADVISOR owner WITH a travel.internal.view grant: full costing", () => {
  it("GET detail and calculate expose costing, traceRows and INTERNAL document metadata", async () => {
    const granted = await createUser("ADVISOR", "intview@perm.io", [
      { key: "travel.internal.view", allowed: true },
    ]);
    const { request, version } = await submittedRequestWithDocs(granted);

    session(granted);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    const scenario = body.versions[0].scenarios[0];
    const parsed = JSON.parse(scenario.resultJson);
    expect(parsed.totals.costQuote).toBe("300");
    expect(parsed.profit).toBeDefined();
    expect(Array.isArray(scenario.traceRows)).toBe(true);
    const kinds = body.versions[0].documents.map((d: any) => d.kind).sort();
    expect(kinds).toEqual(["CLIENT", "INTERNAL"]);

    const calc = await postCalculate(version.id);
    expect(calc.status).toBe(200);
    const calcBody = await calc.json();
    expect(calcBody.scenarios[0].totals.costQuote).toBe("300");
    expect(Array.isArray(calcBody.scenarios[0].traceRows)).toBe(true);
  });
});

describe("stored service-line/stay internals (int-lock: unitRate, overrides, sourceRef, rateOverrides)", () => {
  it("ADMIN sees net rates, override reasons, provenance and stay rateOverrides", async () => {
    const { request } = await submittedRequestWithInternalFields(fx.advisor);
    session(fx.admin);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const line = body.versions[0].serviceLines[0];
    expect(line.label).toBe("Museum tickets");
    expect(line.unitRate).toBe("25");
    expect(line.overrideRate).toBe("20");
    expect(line.overrideReason).toBe("Group discount negotiated with the supplier");
    expect(line.overrideById).toBe(fx.advisor.id);
    expect(line.sourceRef).toBe("Tour Calculator!C58");

    const stay = body.versions[0].scenarios[0].stays[0];
    expect(JSON.parse(stay.rateOverrides).DBL).toMatchObject({ rate: "90", reason: "Negotiated corporate rate" });
  });

  it("ungranted owner of a SUBMITTED (not editable) request gets them stripped", async () => {
    const { request } = await submittedRequestWithInternalFields(fx.advisor);
    session(fx.advisor);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const line = body.versions[0].serviceLines[0];
    expect(line.label).toBe("Museum tickets"); // sell-side display fields stay
    for (const key of INTERNAL_LINE_KEYS) expect(line).not.toHaveProperty(key);
    expect(body.versions[0].scenarios[0].stays[0].rateOverrides).toBeNull();

    // No internal rate, note or provenance survives anywhere in the payload.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Group discount negotiated with the supplier");
    expect(serialized).not.toContain("Negotiated corporate rate");
    expect(serialized).not.toContain("Tour Calculator!C58");
  });

  it("ungranted assigned validator (fx.validator2) gets them stripped", async () => {
    const { request } = await submittedRequestWithInternalFields(fx.advisor);
    session(fx.validator2);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    const line = body.versions[0].serviceLines[0];
    expect(line.label).toBe("Museum tickets");
    for (const key of INTERNAL_LINE_KEYS) expect(line).not.toHaveProperty(key);
    expect(body.versions[0].scenarios[0].stays[0].rateOverrides).toBeNull();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Group discount negotiated with the supplier");
    expect(serialized).not.toContain("Negotiated corporate rate");
    expect(serialized).not.toContain("Tour Calculator!C58");
  });

  it("ungranted owner of an editable DRAFT keeps them (the draft editor round-trips these fields)", async () => {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, contentWithInternalFields());
    session(fx.advisor);
    const res = await getDetail(request.id);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.versions[0].status).toBe("DRAFT");
    const line = body.versions[0].serviceLines[0];
    expect(line.unitRate).toBe("25");
    expect(line.overrideReason).toBe("Group discount negotiated with the supplier");
    expect(line.sourceRef).toBe("Tour Calculator!C58");
    expect(JSON.parse(body.versions[0].scenarios[0].stays[0].rateOverrides).DBL.rate).toBe("90");

    // The engine-result redaction is unaffected by the editor carve-out.
    const parsed = JSON.parse(body.versions[0].scenarios[0].resultJson ?? "null");
    if (parsed !== null) expect(Object.keys(parsed).sort()).toEqual(SELL_SIDE_KEYS);
  });
});
