/**
 * Admin partner review APIs (W5b) — route contract tests.
 *
 * Routes under app/api/admin/partners/, all guarded by requirePartnerReviewer()
 * (partners.review permission — ADMIN preset only):
 * anonymous -> 401 `{error:"Unauthorized"}`; an active user without the
 * permission (USER / ADVISOR / VALIDATOR) -> 403 `{error:"Forbidden"}`.
 *
 * Contract under test:
 *
 * A. GET /api/admin/partners — bare JSON array of application summaries (id,
 *    reference, status, companyLegalName, tradingName, country, city,
 *    contactName, contactEmail, licenceExpiry, createdAt, reviewedAt), newest
 *    first. `status` query filters (invalid value -> 400); `search` is a
 *    contains-match on reference / companyLegalName / tradingName /
 *    contactName / contactEmail.
 * B. GET /api/admin/partners/[id] — full application including `documents`;
 *    each document exposes id, kind, originalName, mime, size, sha256,
 *    createdAt but NOT storagePath. Unknown id -> 404 `{error:"Not found"}`.
 * C. GET /api/admin/partners/[id]/documents/[docId] — streams the file
 *    (Content-Type = stored mime, Content-Disposition attachment with
 *    filename=, X-Content-Type-Options: nosniff, Cache-Control: private,
 *    no-store) and writes a PARTNER_KYC_DOCUMENT_DOWNLOADED Log row with
 *    userId = reviewer and details naming the reference and the document id.
 *    Unknown or cross-application docId -> 404. Refused roles write no audit
 *    row.
 * D. POST /api/admin/partners/[id]/decision — body
 *    `{ action: "approve"|"reject"|"request-info", shortCode?, decisionNote? }`.
 *    Unknown action / malformed body -> 400; any action on an APPROVED
 *    application -> 409 `{error:"Application is already approved"}`.
 *    reject / request-info require a non-blank decisionNote (400
 *    `{error:"decisionNote is required"}`), set status + trimmed note +
 *    reviewedById/At, email the applicant (reference + note) and write
 *    PARTNER_APPLICATION_REJECTED / _INFO_REQUESTED. approve derives the
 *    default shortCode from the company letters ("Acme Travel LLC" ->
 *    "ACMETRAVEL"), normalises an explicit code (trim + uppercase), rejects
 *    results not matching /^[A-Z]{3,10}$/ (400
 *    `{error:"shortCode must be 3-10 uppercase letters"}`) and collisions with
 *    an existing Agency (409 `{error:"shortCode is already in use"}`); success
 *    creates the Agency, marks the application APPROVED (agencyId,
 *    reviewedById, reviewedAt), emails the applicant and writes
 *    PARTNER_APPLICATION_APPROVED, responding `{ application, agency }`.
 *    Refused roles send no email and write no audit rows. Unknown id -> 404.
 * E. DELETE /api/admin/partners/[id] — deletes only the KYC documents (files
 *    + PartnerDocument rows + the application's storage directory), never the
 *    application; 200 `{ deletedFiles, deletedRows }` and a
 *    PARTNER_KYC_DOCUMENTS_DELETED Log row naming the reference. Unknown
 *    id -> 404.
 *
 * Hermetic setup mirrors apply-api.test.ts: a throwaway SQLite database
 * (travel-db helpers), KYC_STORAGE_DIR pointed at a fresh os.tmpdir()
 * directory BEFORE any route module is dynamically imported, getServerSession
 * mocked through a sessionRef (the guard re-reads the user row from the DB),
 * and @/lib/email mocked. All tests share the one database, so references,
 * emails and shortCodes are handed out by counters.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { PrismaClient, User } from "@prisma/client";

// Must be set before any route module (and lib/partners/kyc-storage) loads.
const KYC_TEST_DIR = path.join(
  os.tmpdir(),
  `kyc-review-api-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.KYC_STORAGE_DIR = KYC_TEST_DIR;
process.env.NEXTAUTH_SECRET = String("review-api-test-secret-min-32-characters!");

import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { sendEmail } from "@/lib/email";

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

const sendEmailMock = vi.mocked(sendEmail);

let prisma: PrismaClient;
let listGET: typeof import("@/app/api/admin/partners/route").GET;
let detailGET: typeof import("@/app/api/admin/partners/[id]/route").GET;
let detailDELETE: typeof import("@/app/api/admin/partners/[id]/route").DELETE;
let documentGET: typeof import("@/app/api/admin/partners/[id]/documents/[docId]/route").GET;
let decisionPOST: typeof import("@/app/api/admin/partners/[id]/decision/route").POST;

let adminUser: User;
const refusedUsers = {} as Record<"USER" | "ADVISOR" | "VALIDATOR", User>;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  // The reviewer guard re-reads the user row from the database, so the
  // mocked sessions must point at real rows; the DB role decides.
  adminUser = await prisma.user.create({
    data: { email: "w5b-review-admin@test.io", name: "Review Admin", password: "x", role: "ADMIN" },
  });
  for (const role of ["USER", "ADVISOR", "VALIDATOR"] as const) {
    refusedUsers[role] = await prisma.user.create({
      data: {
        email: `w5b-review-${role.toLowerCase()}@test.io`,
        name: `Review ${role}`,
        password: "x",
        role,
      },
    });
  }

  listGET = (await import("@/app/api/admin/partners/route")).GET;
  const detailRoute = await import("@/app/api/admin/partners/[id]/route");
  detailGET = detailRoute.GET;
  detailDELETE = detailRoute.DELETE;
  documentGET = (await import("@/app/api/admin/partners/[id]/documents/[docId]/route")).GET;
  decisionPOST = (await import("@/app/api/admin/partners/[id]/decision/route")).POST;
});

beforeEach(() => {
  sendEmailMock.mockClear();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fsp.rm(KYC_TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const BASE = "http://localhost:3000/api/admin/partners";
const REFUSED_ROLES = ["USER", "ADVISOR", "VALIDATOR"] as const;

function sessionFor(user: User) {
  return {
    user: { id: user.id, role: user.role, email: user.email, name: user.name },
    expires: "2099-01-01",
  };
}

function asAdmin() {
  sessionRef.current = sessionFor(adminUser);
}
function asUser() {
  sessionRef.current = sessionFor(refusedUsers.USER);
}
function asAdvisor() {
  sessionRef.current = sessionFor(refusedUsers.ADVISOR);
}
function asValidator() {
  sessionRef.current = sessionFor(refusedUsers.VALIDATOR);
}
function asAnonymous() {
  sessionRef.current = null;
}

const REFUSED_ROLE_SETTERS = { USER: asUser, ADVISOR: asAdvisor, VALIDATOR: asValidator } as const;

// Same TS 5.9 DOM-typing idiom as apply-api.test.ts: pin the ArrayBuffer
// generic so the view stays assignable where BlobPart/BufferSource is wanted.
function pdfBytes(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from(`% ${tag}\n`),
      Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
    ]),
  );
}

let refCounter = 0;

interface SeedApplicationOptions {
  status?: string;
  companyLegalName?: string;
  tradingName?: string | null;
  contactEmail?: string;
  createdAt?: Date;
  reviewedAt?: Date | null;
  reviewedById?: string | null;
  decisionNote?: string | null;
  agencyId?: string | null;
}

/** Minimal schema-valid PartnerApplication with a unique PA-2026-7xxx reference. */
async function seedApplication(options: SeedApplicationOptions = {}) {
  refCounter += 1;
  const reference = `PA-2026-7${String(refCounter).padStart(3, "0")}`;
  return prisma.partnerApplication.create({
    data: {
      reference,
      status: options.status ?? "SUBMITTED",
      companyLegalName: options.companyLegalName ?? `Review Seed Co ${reference}`,
      tradingName:
        options.tradingName === undefined ? `Review Trading ${reference}` : options.tradingName,
      country: "AE",
      city: "Dubai",
      address: "1 Review Street",
      licenceNumber: `LIC-${reference}`,
      licenceAuthority: "DET",
      licenceExpiry: "2027-01-01",
      contactName: "Seed Contact",
      contactEmail: options.contactEmail ?? `seed-${reference.toLowerCase()}@example.com`,
      contactPhone: "+971500000000",
      consentKyc: true,
      consentChannels: true,
      consentVersion: "2026-10-v1",
      ipHash: `iphash-${reference}`,
      createdAt: options.createdAt ?? new Date("2026-05-01T00:00:00.000Z"),
      reviewedAt: options.reviewedAt ?? null,
      reviewedById: options.reviewedById ?? null,
      decisionNote: options.decisionNote ?? null,
      agencyId: options.agencyId ?? null,
    },
  });
}

/**
 * Writes a real PDF file under $KYC_STORAGE_DIR/<applicationId>/ and the
 * matching PartnerDocument row (storagePath/size/sha256 consistent).
 */
async function seedDocument(applicationId: string, kind: string = "TRADE_LICENCE") {
  const data = pdfBytes(`${applicationId}-${crypto.randomBytes(4).toString("hex")}`);
  const dir = path.join(KYC_TEST_DIR, applicationId);
  await fsp.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.pdf`);
  await fsp.writeFile(storagePath, data);
  const document = await prisma.partnerDocument.create({
    data: {
      applicationId,
      kind,
      originalName: `${kind.toLowerCase().replace(/_/g, "-")}.pdf`,
      mime: "application/pdf",
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      storagePath,
    },
  });
  return { document, data: Buffer.from(data) };
}

let codeCounter = 0;
/** Unique 3-10 uppercase-letter shortCode (RWA, RWB, ...). */
function nextShortCode(): string {
  codeCounter += 1;
  let n = codeCounter;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `RW${letters}`;
}

function listRequest(query: string = ""): NextRequest {
  return new NextRequest(`${BASE}${query}`);
}

function decisionRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE}/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function findLog(action: string, contains: string) {
  return prisma.log.findFirst({ where: { action, details: { contains } } });
}

/** Single-email assertion: recipient plus reference (and optionally the note). */
function expectApplicantEmail(to: string, reference: string, alsoContains?: string) {
  expect(sendEmailMock).toHaveBeenCalledTimes(1);
  const call = sendEmailMock.mock.calls[0][0] as { to: string; subject: string; text: string };
  expect(call.to).toBe(to);
  expect(`${call.subject}\n${call.text}`).toContain(reference);
  if (alsoContains !== undefined) {
    expect(`${call.subject}\n${call.text}`).toContain(alsoContains);
  }
}

// ---------------------------------------------------------------------------
// A. GET /api/admin/partners — list
// ---------------------------------------------------------------------------

describe("GET /api/admin/partners — roles", () => {
  it("rejects anonymous callers with 401", async () => {
    asAnonymous();
    const res = await listGET(listRequest());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  for (const role of REFUSED_ROLES) {
    it(`rejects ${role} with 403`, async () => {
      REFUSED_ROLE_SETTERS[role]();
      const res = await listGET(listRequest());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }

  it("allows ADMIN", async () => {
    asAdmin();
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

describe("GET /api/admin/partners — list behaviour", () => {
  it("returns summaries newest first with the contract fields", async () => {
    const oldest = await seedApplication({ createdAt: new Date("2026-01-10T00:00:00.000Z") });
    const middle = await seedApplication({ createdAt: new Date("2026-02-10T00:00:00.000Z") });
    const newest = await seedApplication({ createdAt: new Date("2026-03-10T00:00:00.000Z") });

    asAdmin();
    const res = await listGET(listRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    const seededIds = new Set([oldest.id, middle.id, newest.id]);
    const ordered = body
      .map((item: { id: string }) => item.id)
      .filter((id: string) => seededIds.has(id));
    expect(ordered).toEqual([newest.id, middle.id, oldest.id]);

    const item = body.find((entry: { id: string }) => entry.id === newest.id);
    expect(item).toMatchObject({
      reference: newest.reference,
      status: "SUBMITTED",
      companyLegalName: newest.companyLegalName,
      tradingName: newest.tradingName,
      country: "AE",
      city: "Dubai",
      contactName: newest.contactName,
      contactEmail: newest.contactEmail,
      licenceExpiry: "2027-01-01",
      reviewedAt: null,
    });
    expect(typeof item.createdAt).toBe("string");
  });

  it("filters by status and rejects an invalid status with 400", async () => {
    const rejected = await seedApplication({ status: "REJECTED" });
    const submitted = await seedApplication({ status: "SUBMITTED" });

    asAdmin();
    const res = await listGET(listRequest("?status=REJECTED"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.every((item: { status: string }) => item.status === "REJECTED")).toBe(true);
    expect(body.some((item: { id: string }) => item.id === rejected.id)).toBe(true);
    expect(body.some((item: { id: string }) => item.id === submitted.id)).toBe(false);

    const badRes = await listGET(listRequest("?status=BOGUS"));
    expect(badRes.status).toBe(400);
  });

  it("matches search against the searchable fields and returns [] on a miss", async () => {
    const hit = await seedApplication({ companyLegalName: "Quixotic Voyages Ltd" });

    asAdmin();
    const hitRes = await listGET(listRequest("?search=Quixotic"));
    expect(hitRes.status).toBe(200);
    const hitBody = await hitRes.json();
    expect(hitBody.some((item: { id: string }) => item.id === hit.id)).toBe(true);

    const missRes = await listGET(listRequest("?search=zz-no-such-term-zz"));
    expect(missRes.status).toBe(200);
    expect(await missRes.json()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. GET /api/admin/partners/[id] — detail
// ---------------------------------------------------------------------------

describe("GET /api/admin/partners/[id] — roles", () => {
  it("rejects anonymous callers with 401", async () => {
    const app = await seedApplication();
    asAnonymous();
    const res = await detailGET(new NextRequest(`${BASE}/${app.id}`), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  for (const role of REFUSED_ROLES) {
    it(`rejects ${role} with 403`, async () => {
      const app = await seedApplication();
      REFUSED_ROLE_SETTERS[role]();
      const res = await detailGET(new NextRequest(`${BASE}/${app.id}`), {
        params: Promise.resolve({ id: app.id }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  }

  it("allows ADMIN", async () => {
    const app = await seedApplication();
    asAdmin();
    const res = await detailGET(new NextRequest(`${BASE}/${app.id}`), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/partners/[id] — detail behaviour", () => {
  it("returns the full application with documents that hide storagePath", async () => {
    const app = await seedApplication();
    const { document } = await seedDocument(app.id);

    asAdmin();
    const res = await detailGET(new NextRequest(`${BASE}/${app.id}`), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(app.id);
    expect(body.reference).toBe(app.reference);
    expect(body.companyLegalName).toBe(app.companyLegalName);

    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents).toHaveLength(1);
    const doc = body.documents[0];
    expect(doc).toMatchObject({
      id: document.id,
      kind: "TRADE_LICENCE",
      originalName: document.originalName,
      mime: "application/pdf",
      size: document.size,
      sha256: document.sha256,
    });
    expect(typeof doc.createdAt).toBe("string");
    expect("storagePath" in doc).toBe(false);
  });

  it("returns 404 for an unknown id", async () => {
    asAdmin();
    const res = await detailGET(new NextRequest(`${BASE}/no-such-application`), {
      params: Promise.resolve({ id: "no-such-application" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

// ---------------------------------------------------------------------------
// C. GET /api/admin/partners/[id]/documents/[docId] — KYC download
// ---------------------------------------------------------------------------

describe("GET /api/admin/partners/[id]/documents/[docId] — roles", () => {
  it("rejects anonymous callers with 401 and writes no audit row", async () => {
    const app = await seedApplication();
    const { document } = await seedDocument(app.id);
    asAnonymous();
    const res = await documentGET(new NextRequest(`${BASE}/${app.id}/documents/${document.id}`), {
      params: Promise.resolve({ id: app.id, docId: document.id }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(await findLog("PARTNER_KYC_DOCUMENT_DOWNLOADED", app.reference)).toBeNull();
  });

  for (const role of REFUSED_ROLES) {
    it(`rejects ${role} with 403 and writes no audit row`, async () => {
      const app = await seedApplication();
      const { document } = await seedDocument(app.id);
      REFUSED_ROLE_SETTERS[role]();
      const res = await documentGET(
        new NextRequest(`${BASE}/${app.id}/documents/${document.id}`),
        { params: Promise.resolve({ id: app.id, docId: document.id }) },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      expect(await findLog("PARTNER_KYC_DOCUMENT_DOWNLOADED", app.reference)).toBeNull();
    });
  }

  it("allows ADMIN", async () => {
    const app = await seedApplication();
    const { document } = await seedDocument(app.id);
    asAdmin();
    const res = await documentGET(new NextRequest(`${BASE}/${app.id}/documents/${document.id}`), {
      params: Promise.resolve({ id: app.id, docId: document.id }),
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/partners/[id]/documents/[docId] — download behaviour", () => {
  it("streams the exact file bytes with safe headers and audits the download", async () => {
    const app = await seedApplication();
    const { document, data } = await seedDocument(app.id);

    asAdmin();
    const res = await documentGET(new NextRequest(`${BASE}/${app.id}/documents/${document.id}`), {
      params: Promise.resolve({ id: app.id, docId: document.id }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition.startsWith("attachment")).toBe(true);
    expect(disposition).toContain("filename=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const downloaded = Buffer.from(await res.arrayBuffer());
    expect(downloaded.equals(data)).toBe(true);

    const log = await findLog("PARTNER_KYC_DOCUMENT_DOWNLOADED", app.reference);
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(adminUser.id);
    expect(log!.details).toContain(document.id);
  });

  it("returns 404 for an unknown docId", async () => {
    const app = await seedApplication();
    asAdmin();
    const res = await documentGET(new NextRequest(`${BASE}/${app.id}/documents/no-such-doc`), {
      params: Promise.resolve({ id: app.id, docId: "no-such-doc" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a docId that belongs to a different application", async () => {
    const appA = await seedApplication();
    const appB = await seedApplication();
    const { document: docB } = await seedDocument(appB.id);

    asAdmin();
    const res = await documentGET(new NextRequest(`${BASE}/${appA.id}/documents/${docB.id}`), {
      params: Promise.resolve({ id: appA.id, docId: docB.id }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// D. POST /api/admin/partners/[id]/decision
// ---------------------------------------------------------------------------

describe("POST /api/admin/partners/[id]/decision — roles", () => {
  it("rejects anonymous callers with 401 and sends no email / writes no audit row", async () => {
    const app = await seedApplication();
    asAnonymous();
    const res = await decisionPOST(decisionRequest(app.id, { action: "reject", decisionNote: "no" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await findLog("PARTNER_APPLICATION_REJECTED", app.reference)).toBeNull();
    const unchanged = await prisma.partnerApplication.findUnique({ where: { id: app.id } });
    expect(unchanged!.status).toBe("SUBMITTED");
  });

  for (const role of REFUSED_ROLES) {
    it(`rejects ${role} with 403 and sends no email / writes no audit row`, async () => {
      const app = await seedApplication();
      REFUSED_ROLE_SETTERS[role]();
      const res = await decisionPOST(
        decisionRequest(app.id, { action: "reject", decisionNote: "no" }),
        { params: Promise.resolve({ id: app.id }) },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect(await findLog("PARTNER_APPLICATION_REJECTED", app.reference)).toBeNull();
      const unchanged = await prisma.partnerApplication.findUnique({ where: { id: app.id } });
      expect(unchanged!.status).toBe("SUBMITTED");
    });
  }

  it("allows ADMIN", async () => {
    const app = await seedApplication();
    asAdmin();
    const res = await decisionPOST(
      decisionRequest(app.id, { action: "reject", decisionNote: "not a fit" }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/partners/[id]/decision — request validation", () => {
  it("rejects a malformed body and an unknown action with 400", async () => {
    const app = await seedApplication();
    asAdmin();

    const malformed = await decisionPOST(decisionRequest(app.id, "this is not json"), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(malformed.status).toBe(400);

    const unknownAction = await decisionPOST(decisionRequest(app.id, { action: "explode" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(unknownAction.status).toBe(400);
  });

  it("returns 404 for an unknown application id", async () => {
    asAdmin();
    const res = await decisionPOST(
      decisionRequest("no-such-application", { action: "reject", decisionNote: "no" }),
      { params: Promise.resolve({ id: "no-such-application" }) },
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for any action on an already-approved application", async () => {
    const app = await seedApplication({ status: "APPROVED" });
    asAdmin();
    for (const action of ["approve", "reject", "request-info"] as const) {
      const res = await decisionPOST(
        decisionRequest(app.id, {
          action,
          decisionNote: "valid note",
          shortCode: nextShortCode(),
        }),
        { params: Promise.resolve({ id: app.id }) },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Application is already approved" });
    }
  });
});

describe("POST /api/admin/partners/[id]/decision — reject and request-info", () => {
  it("requires a non-blank decisionNote", async () => {
    const app = await seedApplication();
    asAdmin();
    for (const action of ["reject", "request-info"] as const) {
      for (const body of [{ action }, { action, decisionNote: "   " }]) {
        const res = await decisionPOST(decisionRequest(app.id, body), {
          params: Promise.resolve({ id: app.id }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "decisionNote is required" });
      }
    }
  });

  it("rejects with a trimmed note, emails the applicant and audits the decision", async () => {
    const app = await seedApplication();
    asAdmin();
    const res = await decisionPOST(
      decisionRequest(app.id, { action: "reject", decisionNote: "  Incomplete licence copy.  " }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(res.status).toBe(200);

    const updated = await prisma.partnerApplication.findUnique({ where: { id: app.id } });
    expect(updated!.status).toBe("REJECTED");
    expect(updated!.decisionNote).toBe("Incomplete licence copy.");
    expect(updated!.reviewedById).toBe(adminUser.id);
    expect(updated!.reviewedAt).toBeTruthy();

    expectApplicantEmail(app.contactEmail, app.reference, "Incomplete licence copy.");

    const log = await findLog("PARTNER_APPLICATION_REJECTED", app.reference);
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(adminUser.id);
  });

  it("requests info, emails the applicant and audits the decision", async () => {
    const app = await seedApplication();
    asAdmin();
    const res = await decisionPOST(
      decisionRequest(app.id, { action: "request-info", decisionNote: "Please resend the ID." }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(res.status).toBe(200);

    const updated = await prisma.partnerApplication.findUnique({ where: { id: app.id } });
    expect(updated!.status).toBe("INFO_REQUESTED");
    expect(updated!.decisionNote).toBe("Please resend the ID.");
    expect(updated!.reviewedById).toBe(adminUser.id);
    expect(updated!.reviewedAt).toBeTruthy();

    expectApplicantEmail(app.contactEmail, app.reference, "Please resend the ID.");

    const log = await findLog("PARTNER_APPLICATION_INFO_REQUESTED", app.reference);
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(adminUser.id);
  });
});

describe("POST /api/admin/partners/[id]/decision — approve", () => {
  it("derives the default shortCode from the company name and creates the Agency", async () => {
    const app = await seedApplication({ companyLegalName: "Acme Travel LLC" });
    asAdmin();
    const res = await decisionPOST(decisionRequest(app.id, { action: "approve" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.application).toBeTruthy();
    expect(body.agency).toBeTruthy();
    expect(body.agency.shortCode).toBe("ACMETRAVEL");
    expect(body.agency.name).toBe("Acme Travel LLC");
    expect(body.agency.contactName).toBe(app.contactName);
    expect(body.agency.contactEmail).toBe(app.contactEmail);
    expect(body.agency.contactPhone).toBe(app.contactPhone);

    const updated = await prisma.partnerApplication.findUnique({ where: { id: app.id } });
    expect(updated!.status).toBe("APPROVED");
    expect(updated!.agencyId).toBe(body.agency.id);
    expect(updated!.reviewedById).toBe(adminUser.id);
    expect(updated!.reviewedAt).toBeTruthy();
    expect(updated!.decisionNote).toBeNull();

    expectApplicantEmail(app.contactEmail, app.reference);

    const log = await findLog("PARTNER_APPLICATION_APPROVED", app.reference);
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(adminUser.id);
    expect(log!.details).toContain("ACMETRAVEL");
  });

  it("trims and uppercases an explicit shortCode", async () => {
    const app = await seedApplication();
    const code = nextShortCode();
    asAdmin();
    const res = await decisionPOST(
      decisionRequest(app.id, { action: "approve", shortCode: `  ${code.toLowerCase()}  ` }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agency.shortCode).toBe(code);
  });

  it("rejects an explicit shortCode that is not 3-10 uppercase letters", async () => {
    const app = await seedApplication();
    asAdmin();
    for (const bad of ["AB", "ABC123"]) {
      const res = await decisionPOST(decisionRequest(app.id, { action: "approve", shortCode: bad }), {
        params: Promise.resolve({ id: app.id }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "shortCode must be 3-10 uppercase letters" });
    }
  });

  it("rejects approve when the company name yields no shortCode proposal", async () => {
    const app = await seedApplication({ companyLegalName: "12345" });
    asAdmin();
    const res = await decisionPOST(decisionRequest(app.id, { action: "approve" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "shortCode must be 3-10 uppercase letters" });
  });

  it("returns 409 when the shortCode is already taken by an Agency", async () => {
    const code = nextShortCode();
    await prisma.agency.create({ data: { shortCode: code, name: "Existing Agency" } });
    const app = await seedApplication();
    asAdmin();
    const res = await decisionPOST(decisionRequest(app.id, { action: "approve", shortCode: code }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "shortCode is already in use" });
  });
});

// ---------------------------------------------------------------------------
// E. DELETE /api/admin/partners/[id] — delete KYC documents
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/partners/[id] — roles", () => {
  it("rejects anonymous callers with 401", async () => {
    const app = await seedApplication();
    await seedDocument(app.id);
    asAnonymous();
    const res = await detailDELETE(new NextRequest(`${BASE}/${app.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(await prisma.partnerDocument.count({ where: { applicationId: app.id } })).toBe(1);
  });

  for (const role of REFUSED_ROLES) {
    it(`rejects ${role} with 403 and keeps the documents`, async () => {
      const app = await seedApplication();
      await seedDocument(app.id);
      REFUSED_ROLE_SETTERS[role]();
      const res = await detailDELETE(new NextRequest(`${BASE}/${app.id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id: app.id }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
      expect(await prisma.partnerDocument.count({ where: { applicationId: app.id } })).toBe(1);
      expect(await findLog("PARTNER_KYC_DOCUMENTS_DELETED", app.reference)).toBeNull();
    });
  }

  it("allows ADMIN", async () => {
    const app = await seedApplication();
    await seedDocument(app.id);
    asAdmin();
    const res = await detailDELETE(new NextRequest(`${BASE}/${app.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/partners/[id] — delete behaviour", () => {
  it("deletes the document rows, files and directory but keeps the application", async () => {
    const app = await seedApplication();
    await seedDocument(app.id, "TRADE_LICENCE");
    await seedDocument(app.id, "SIGNATORY_ID");

    asAdmin();
    const res = await detailDELETE(new NextRequest(`${BASE}/${app.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: app.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletedRows).toBe(2);
    expect(body.deletedFiles).toBe(2);

    expect(await prisma.partnerDocument.count({ where: { applicationId: app.id } })).toBe(0);
    expect(await prisma.partnerApplication.findUnique({ where: { id: app.id } })).toBeTruthy();
    await expect(fsp.stat(path.join(KYC_TEST_DIR, app.id))).rejects.toThrow();

    const log = await findLog("PARTNER_KYC_DOCUMENTS_DELETED", app.reference);
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(adminUser.id);
  });

  it("returns 404 for an unknown id", async () => {
    asAdmin();
    const res = await detailDELETE(
      new NextRequest(`${BASE}/no-such-application`, { method: "DELETE" }),
      { params: Promise.resolve({ id: "no-such-application" }) },
    );
    expect(res.status).toBe(404);
  });
});
