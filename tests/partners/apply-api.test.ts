/**
 * Public partner application API (app/api/partners/applications/route.ts):
 * POST /api/partners/applications — a session-free multipart endpoint for B2B
 * partner KYC applications.
 *
 * Contract under test (see the route module header for the full pipeline):
 *
 * - Abuse gates run before any database work: the honeypot field
 *   (HONEYPOT_FIELD = "companyFax") must be empty, and the signed form token
 *   (issueFormToken / verifyFormToken, MIN_FILL_MS = 3000) must verify. All
 *   pre-validation rejections share ONE generic 400 body so bots cannot tell
 *   which tripwire fired; the honeypot response never names the honeypot.
 *   With NEXTAUTH_SECRET unset, the token check fails closed (no hardcoded
 *   fallback may stand in for the secret).
 * - Field validation is the zod schema from lib/partners/validation.ts;
 *   failures return 400 with `{ error: <ZodIssue array> }` (the only non-
 *   generic error shape). Both consents must be the string "true" and the
 *   consent version must equal CONSENT_VERSION.
 * - Files: licenceFile is required (400 string error when absent);
 *   signatoryIdFile and otherFile are optional. Type is decided by MAGIC
 *   BYTES with a matching extension; > 10 MB, non-PDF/JPG/PNG content and
 *   extension lies all map to one generic 400 file error.
 * - Submission limits are counted on the PartnerApplication table: 3 per
 *   hashed client IP per rolling hour, 50 per UTC day globally; both return
 *   429 with a generic single-string body. The client IP is the first
 *   x-forwarded-for hop; only hashClientIp(ip) is stored.
 * - Success creates the PartnerApplication (status SUBMITTED, reference
 *   PA-YYYY-NNNN) plus the PartnerDocument rows in ONE transaction, with the
 *   files written to disk inside the transaction callback. If the
 *   transaction fails, the written files are discarded and the response is a
 *   generic 500 that must not leak the underlying error message. A Log row
 *   PARTNER_APPLICATION_SUBMITTED (userId null) is written, and two emails
 *   go out (applicant confirmation carrying the reference, staff alert to
 *   reservation@nare.am); the response is 200 `{ reference }`.
 *
 * Hermetic setup: DATABASE_URL points at a throwaway SQLite file (shared
 * travel-db helpers), KYC_STORAGE_DIR is a fresh os.tmpdir() directory set
 * BEFORE the route module is imported (lib/partners/kyc-storage reads it at
 * module load — so nothing that transitively imports kyc-storage is
 * statically imported here), and @/lib/email is mocked.
 *
 * Quota bookkeeping: only SUCCESSFUL submissions and directly seeded rows
 * count against the limits, so every successful POST uses its own
 * 198.51.100.x address, the per-IP test seeds its own 203.0.113.7 bucket,
 * and the per-day test (which seeds 50 rows and pushes the day total over
 * the limit) runs LAST — after it, no test may need a successful POST.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Must be set before the route module (and lib/partners/kyc-storage) loads.
const KYC_TEST_DIR = path.join(
  os.tmpdir(),
  `kyc-apply-api-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.KYC_STORAGE_DIR = KYC_TEST_DIR;
// lib/partners/abuse.ts fails closed when NEXTAUTH_SECRET is unset (it signs
// the form token and salts the stored IP hash), so tests need one.
process.env.NEXTAUTH_SECRET = String("apply-api-test-secret-min-32-characters!");

import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { CONSENT_VERSION } from "@/lib/partners/validation";
import {
  HONEYPOT_FIELD,
  MAX_PER_DAY_GLOBAL,
  MAX_PER_IP_PER_HOUR,
  hashClientIp,
  issueFormToken,
} from "@/lib/partners/abuse";
import { sendEmail } from "@/lib/email";

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));

const sendEmailMock = vi.mocked(sendEmail);

let prisma: PrismaClient;
let POST: typeof import("@/app/api/partners/applications/route").POST;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  POST = (await import("@/app/api/partners/applications/route")).POST;
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

const KYC_MAX_FILE_BYTES = 10 * 1024 * 1024;
const STAFF_ALERT_ADDRESS = "reservation@nare.am";

// File constructors take BlobPart, which under the TS 5.9 DOM types only
// accepts ArrayBuffer-backed views — a plain `Uint8Array` annotation widens
// the buffer to ArrayBufferLike and fails the check, so pin the generic.
function validPdf(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
    ]),
  );
}

function validPng(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
    ]),
  );
}

function validJpg(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
}

function sha256Hex(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter += 1;
  return `applicant-${Date.now()}-${emailCounter}@example.com`;
}

let ipCounter = 0;
/** Each call hands out a fresh TEST-NET-2 address so per-IP quotas stay isolated. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

interface BuildFormOptions {
  /** Field overrides; a null value OMITS the field from the form. */
  fields?: Record<string, string | null>;
  /** undefined = default small valid PDF; null = omit the file entirely. */
  licenceFile?: File | null;
  signatoryIdFile?: File;
  otherFile?: File;
  /** undefined = valid token aged past MIN_FILL_MS; null = omit the field. */
  formToken?: string | null;
}

function buildForm(options: BuildFormOptions = {}): FormData {
  const fields: Record<string, string> = {
    companyLegalName: "Acme Travel LLC",
    country: "AE",
    city: "Dubai",
    address: "123 Sheikh Zayed Road",
    licenceNumber: "LIC-123456",
    licenceAuthority: "Department of Economy and Tourism",
    licenceExpiry: "2027-01-01",
    contactName: "Jane Doe",
    contactEmail: uniqueEmail(),
    contactPhone: "+971 50 000 0000",
    consentKyc: "true",
    consentChannels: "true",
    consentVersion: CONSENT_VERSION,
  };
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    if (value === null) delete fields[key];
    else fields[key] = value;
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);

  const token =
    options.formToken === undefined ? issueFormToken(Date.now() - 4000) : options.formToken;
  if (token !== null) form.append("formToken", token);

  const licence =
    options.licenceFile === undefined
      ? new File([validPdf()], "licence.pdf", { type: "application/pdf" })
      : options.licenceFile;
  if (licence !== null) form.append("licenceFile", licence);
  if (options.signatoryIdFile) form.append("signatoryIdFile", options.signatoryIdFile);
  if (options.otherFile) form.append("otherFile", options.otherFile);
  return form;
}

async function postForm(form: FormData, ip: string = nextIp()) {
  return POST(
    new NextRequest("http://localhost:3000/api/partners/applications", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": ip },
    }),
  );
}

/** Recursively lists files (relative paths, sorted) under the temp KYC dir. */
async function listKycFiles(dir: string = KYC_TEST_DIR, prefix: string = ""): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out = out.concat(await listKycFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Minimal schema-valid row for seeding the abuse-limit counters. */
function seedApplication(data: { reference: string; ipHash: string }) {
  return prisma.partnerApplication.create({
    data: {
      reference: data.reference,
      companyLegalName: `Seed Company ${data.reference}`,
      country: "AE",
      city: "Dubai",
      address: "1 Seed Street",
      licenceNumber: `LIC-${data.reference}`,
      licenceAuthority: "DET",
      licenceExpiry: "2027-01-01",
      contactName: "Seed Contact",
      contactEmail: `seed-${data.reference.toLowerCase()}@example.com`,
      contactPhone: "+971500000000",
      consentKyc: true,
      consentChannels: true,
      consentVersion: "2026-10-v1",
      ipHash: data.ipHash,
    },
  });
}

/** Asserts the exact generic error shape: `{ error: <single string> }`. */
function expectGenericErrorBody(body: unknown): asserts body is { error: string } {
  expect(Object.keys(body as object).sort()).toEqual(["error"]);
  expect(typeof (body as { error: unknown }).error).toBe("string");
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — success", () => {
  it("stores the application, document, file, audit log and sends both emails", async () => {
    const ip = nextIp();
    const email = uniqueEmail();
    const pdf = validPdf();
    const licenceFile = new File([pdf], "../trade licence.pdf", { type: "application/pdf" });

    const res = await postForm(buildForm({ fields: { contactEmail: email }, licenceFile }), ip);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reference).toMatch(/^PA-\d{4}-\d{4,}$/);
    const reference: string = body.reference;

    const application = await prisma.partnerApplication.findUnique({ where: { reference } });
    expect(application).toBeTruthy();
    expect(application!).toMatchObject({
      status: "SUBMITTED",
      companyLegalName: "Acme Travel LLC",
      country: "AE",
      city: "Dubai",
      address: "123 Sheikh Zayed Road",
      licenceNumber: "LIC-123456",
      licenceAuthority: "Department of Economy and Tourism",
      licenceExpiry: "2027-01-01",
      contactName: "Jane Doe",
      contactEmail: email,
      contactPhone: "+971500000000",
      consentKyc: true,
      consentChannels: true,
      consentVersion: CONSENT_VERSION,
      ipHash: hashClientIp(ip),
    });

    const documents = await prisma.partnerDocument.findMany({
      where: { applicationId: application!.id },
    });
    expect(documents).toHaveLength(1);
    const document = documents[0];
    expect(document.kind).toBe("TRADE_LICENCE");
    expect(document.mime).toBe("application/pdf");
    expect(document.size).toBe(pdf.length);
    expect(document.sha256).toBe(sha256Hex(pdf));
    // Sanitised: reduced to a basename, no path separators.
    expect(document.originalName).toBe("trade licence.pdf");
    expect(document.originalName).not.toContain("/");

    expect(document.storagePath.startsWith(KYC_TEST_DIR + path.sep)).toBe(true);
    const onDisk = await fsp.readFile(document.storagePath);
    expect(onDisk.equals(pdf)).toBe(true);

    const log = await prisma.log.findFirst({
      where: { action: "PARTNER_APPLICATION_SUBMITTED", details: { contains: reference } },
    });
    expect(log).toBeTruthy();
    expect(log!.userId).toBeNull();

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const [applicantCall, staffCall] = sendEmailMock.mock.calls;
    expect(applicantCall[0].to).toBe(email);
    expect(`${applicantCall[0].subject}\n${applicantCall[0].text}`).toContain(reference);
    expect(staffCall[0].to).toBe(STAFF_ALERT_ADDRESS);
    expect(`${staffCall[0].subject}\n${staffCall[0].text}`).toContain(reference);
  });

  it("stores all three document kinds when the optional files are present", async () => {
    const res = await postForm(
      buildForm({
        signatoryIdFile: new File([validPng()], "passport.png", { type: "image/png" }),
        otherFile: new File([validJpg()], "office.jpg", { type: "image/jpeg" }),
      }),
    );
    expect(res.status).toBe(200);
    const { reference } = await res.json();

    const application = await prisma.partnerApplication.findUnique({ where: { reference } });
    const documents = await prisma.partnerDocument.findMany({
      where: { applicationId: application!.id },
    });
    expect(documents).toHaveLength(3);
    const byKind = new Map(documents.map((d) => [d.kind, d]));
    expect(byKind.get("TRADE_LICENCE")?.mime).toBe("application/pdf");
    expect(byKind.get("SIGNATORY_ID")?.mime).toBe("image/png");
    expect(byKind.get("SIGNATORY_ID")?.originalName).toBe("passport.png");
    expect(byKind.get("OTHER")?.mime).toBe("image/jpeg");
    expect(byKind.get("OTHER")?.originalName).toBe("office.jpg");
    for (const document of documents) {
      expect(document.storagePath.startsWith(KYC_TEST_DIR + path.sep)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Field validation (400 with a ZodIssue array)
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — field validation", () => {
  async function expectValidation400(form: FormData) {
    const res = await postForm(form);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(Array.isArray(body.error)).toBe(true);
    expect(body.error.length).toBeGreaterThan(0);
  }

  it("rejects a missing companyLegalName", async () => {
    await expectValidation400(buildForm({ fields: { companyLegalName: null } }));
  });

  it("rejects an invalid contactEmail", async () => {
    await expectValidation400(buildForm({ fields: { contactEmail: "not-an-email" } }));
  });

  it("rejects a too-short contactPhone", async () => {
    await expectValidation400(buildForm({ fields: { contactPhone: "+97123" } }));
  });

  it("rejects an impossible licenceExpiry calendar date", async () => {
    await expectValidation400(buildForm({ fields: { licenceExpiry: "2026-13-99" } }));
  });

  it("rejects a missing consentKyc", async () => {
    await expectValidation400(buildForm({ fields: { consentKyc: null } }));
  });

  it("rejects a missing consentChannels", async () => {
    await expectValidation400(buildForm({ fields: { consentChannels: null } }));
  });

  it("rejects a wrong consentVersion", async () => {
    await expectValidation400(buildForm({ fields: { consentVersion: "2020-01-v0" } }));
  });

  it("rejects an invalid website URL", async () => {
    await expectValidation400(buildForm({ fields: { website: "not a url" } }));
  });
});

// ---------------------------------------------------------------------------
// File checks
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — file checks", () => {
  it("rejects a missing licenceFile with a 400 string error", async () => {
    const res = await postForm(buildForm({ licenceFile: null }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expectGenericErrorBody(body);
  });

  it("rejects non-PDF bytes in a .pdf file with the generic file error", async () => {
    const fakeExecutable = new Uint8Array(
      Buffer.concat([Buffer.from("MZ"), Buffer.alloc(32, 0x00)]),
    );
    const res = await postForm(
      buildForm({
        licenceFile: new File([fakeExecutable], "licence.pdf", { type: "application/pdf" }),
      }),
    );
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });

  it("rejects PNG content named .pdf (extension mismatch) with the generic file error", async () => {
    const res = await postForm(
      buildForm({
        licenceFile: new File([validPng()], "licence.pdf", { type: "application/pdf" }),
      }),
    );
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });

  it("rejects a file one byte over the 10 MB limit", async () => {
    const oversized = new Uint8Array(KYC_MAX_FILE_BYTES + 1);
    oversized.set(Buffer.from("%PDF-1.7\n"));
    const res = await postForm(
      buildForm({
        licenceFile: new File([oversized], "licence.pdf", { type: "application/pdf" }),
      }),
    );
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });
});

// ---------------------------------------------------------------------------
// Abuse gates: honeypot and form token
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — abuse gates", () => {
  it("rejects a filled honeypot exactly like a token failure and never names it", async () => {
    const honeypotRes = await postForm(
      buildForm({ fields: { [HONEYPOT_FIELD]: "+1 555 0100" } }),
    );
    expect(honeypotRes.status).toBe(400);
    const honeypotBody = await honeypotRes.json();
    expectGenericErrorBody(honeypotBody);

    const tokenRes = await postForm(buildForm({ formToken: null }));
    const tokenBody = await tokenRes.json();

    expect(honeypotBody).toEqual(tokenBody);
    expect(JSON.stringify(honeypotBody).toLowerCase()).not.toContain("honeypot");
  });

  it("rejects a missing formToken with the generic 400", async () => {
    const res = await postForm(buildForm({ formToken: null }));
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });

  it("rejects a garbage formToken with the generic 400", async () => {
    const res = await postForm(buildForm({ formToken: "not-a-real-token" }));
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });

  it("rejects a fresh formToken submitted faster than the minimum fill time", async () => {
    const res = await postForm(buildForm({ formToken: issueFormToken() }));
    expect(res.status).toBe(400);
    expectGenericErrorBody(await res.json());
  });

  it("fails closed when NEXTAUTH_SECRET is unset", async () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      // A structurally valid token can never verify without the secret —
      // no hardcoded fallback may stand in for it.
      const res = await postForm(buildForm({ formToken: `1234567890.${"a".repeat(64)}` }), nextIp());
      expect(res.status).toBe(400);
      expectGenericErrorBody(await res.json());
      expect(() => issueFormToken()).toThrow();
      expect(() => hashClientIp("203.0.113.99")).toThrow();
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Submission limits (429)
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — submission limits", () => {
  it("returns 429 when the client IP already submitted 3 applications this hour", async () => {
    const limitedIp = "203.0.113.7";
    const ipHash = hashClientIp(limitedIp);
    for (let i = 0; i < MAX_PER_IP_PER_HOUR; i += 1) {
      await seedApplication({ reference: `PA-2026-90${10 + i}`, ipHash });
    }

    const res = await postForm(buildForm(), limitedIp);
    expect(res.status).toBe(429);
    expectGenericErrorBody(await res.json());
    expect(await prisma.partnerApplication.count({ where: { ipHash } })).toBe(MAX_PER_IP_PER_HOUR);
  });
});

describe("POST /api/partners/applications — gates before body parsing", () => {
  it("answers 429 before parsing the body when the IP already used its quota", async () => {
    const limitedIp = "203.0.113.55";
    const ipHash = hashClientIp(limitedIp);
    for (let i = 0; i < MAX_PER_IP_PER_HOUR; i += 1) {
      await seedApplication({ reference: `PA-2026-91${10 + i}`, ipHash });
    }
    // A body that would otherwise be a 400 (no token, not even multipart):
    // the quota gate must answer first, without parsing it.
    const res = await POST(
      new NextRequest("http://localhost:3000/api/partners/applications", {
        method: "POST",
        body: "not a form",
        headers: { "x-forwarded-for": limitedIp, "content-type": "text/plain" },
      }),
    );
    expect(res.status).toBe(429);
  });

  it("refuses a declared body larger than the cap with 413 before reading it", async () => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/partners/applications", {
        method: "POST",
        body: "x",
        headers: { "x-forwarded-for": nextIp(), "content-length": String(40 * 1024 * 1024) },
      }),
    );
    expect(res.status).toBe(413);
    expectGenericErrorBody(await res.json());
  });
});

// ---------------------------------------------------------------------------
// Transaction rollback
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — transaction failure", () => {
  it("rolls back the rows AND discards the written files, returning a leak-free 500", async () => {
    const email = uniqueEmail();
    const filesBefore = await listKycFiles();

    const realTransaction = prisma.$transaction.bind(prisma) as unknown as (
      fn: (tx: { partnerDocument: object }) => Promise<unknown>,
    ) => Promise<unknown>;
    const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(
      ((fn: (tx: { partnerDocument: object }) => Promise<unknown>) =>
        realTransaction(async (tx) => {
          const wrapped = Object.create(tx);
          wrapped.partnerDocument = {
            ...tx.partnerDocument,
            create: async () => {
              throw new Error("injected failure");
            },
          };
          return fn(wrapped);
        })) as never,
    );

    try {
      const res = await postForm(buildForm({ fields: { contactEmail: email } }));
      expect(res.status).toBe(500);
      const body = await res.json();
      expectGenericErrorBody(body);
      expect(body.error).not.toContain("injected failure");
    } finally {
      transactionSpy.mockRestore();
    }

    expect(await prisma.partnerApplication.count({ where: { contactEmail: email } })).toBe(0);
    // The file written inside the failed transaction was discarded.
    expect(await listKycFiles()).toEqual(filesBefore);
  });
});

// ---------------------------------------------------------------------------
// Global per-day limit — runs last: after seeding 50 rows no further
// successful submission would be possible in this day bucket.
// ---------------------------------------------------------------------------

describe("POST /api/partners/applications — global per-day limit", () => {
  it("returns 429 from a fresh IP once 50 applications exist today", async () => {
    for (let i = 0; i < MAX_PER_DAY_GLOBAL; i += 1) {
      await seedApplication({
        reference: `PA-2026-80${String(i + 10).padStart(2, "0")}`,
        ipHash: hashClientIp(`10.0.0.${i}`),
      });
    }

    const res = await postForm(buildForm(), nextIp());
    expect(res.status).toBe(429);
    expectGenericErrorBody(await res.json());
  });
});
