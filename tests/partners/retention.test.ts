import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

const KYC_TEST_DIR = path.join(
  os.tmpdir(),
  `kyc-retention-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
);
process.env.KYC_STORAGE_DIR = KYC_TEST_DIR;

import { ensureSchema, getPrisma } from "../travel-db/helpers";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000);
const EXPIRED_ACTION = "PARTNER_DOCUMENTS_EXPIRED";

let prisma: PrismaClient;
let RETENTION_DAYS: number;
let selectExpiredApplications: typeof import("@/lib/partners/retention").selectExpiredApplications;
let runRetentionSweep: typeof import("@/lib/partners/retention").runRetentionSweep;
let deleteKycDocuments: typeof import("@/lib/partners/kyc-storage").deleteKycDocuments;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  const retention = await import("@/lib/partners/retention");
  RETENTION_DAYS = retention.RETENTION_DAYS;
  selectExpiredApplications = retention.selectExpiredApplications;
  runRetentionSweep = retention.runRetentionSweep;
  deleteKycDocuments = (await import("@/lib/partners/kyc-storage")).deleteKycDocuments;
});

afterAll(async () => {
  await fsp.rm(KYC_TEST_DIR, { recursive: true, force: true });
});

interface SeedApplicationOptions {
  status?: string;
  reviewedAt?: Date | null;
  decisionNote?: string | null;
}

let refCounter = 0;

async function seedApplication(options: SeedApplicationOptions = {}) {
  refCounter += 1;
  const reference = `PA-2026-8${String(refCounter).padStart(3, "0")}`;
  return prisma.partnerApplication.create({
    data: {
      reference,
      status: options.status ?? "REJECTED",
      companyLegalName: `Retention Example Company ${reference}`,
      tradingName: `Retention Example Trading ${reference}`,
      country: "AE",
      city: "Dubai",
      address: `${refCounter} Retention Example Avenue`,
      licenceNumber: `LIC-${reference}`,
      licenceAuthority: "Example Licensing Authority",
      licenceExpiry: "2027-01-01",
      contactName: `Example Contact ${reference}`,
      contactEmail: `retention-${reference.toLowerCase()}@example.com`,
      contactPhone: `+97150000${String(refCounter).padStart(4, "0")}`,
      consentKyc: true,
      consentChannels: true,
      consentVersion: "2026-10-v1",
      ipHash: `retention-ip-${reference}`,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      reviewedAt: options.reviewedAt === undefined ? CUTOFF : options.reviewedAt,
      decisionNote:
        options.decisionNote === undefined
          ? `Private retention decision ${reference}`
          : options.decisionNote,
    },
  });
}

function pdfBytes(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from(`% ${tag}\n`),
      Buffer.from("1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
    ]),
  );
}

async function seedDocument(
  applicationId: string,
  kind: string = "TRADE_LICENCE",
  originalName: string = "retention-example.pdf",
) {
  const data = pdfBytes(`${applicationId}-${crypto.randomBytes(4).toString("hex")}`);
  const dir = path.join(KYC_TEST_DIR, applicationId);
  await fsp.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${crypto.randomBytes(8).toString("hex")}.pdf`);
  await fsp.writeFile(storagePath, data);
  const document = await prisma.partnerDocument.create({
    data: {
      applicationId,
      kind,
      originalName,
      mime: "application/pdf",
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      storagePath,
    },
  });
  return { document, dir };
}

describe("partner KYC retention", () => {
  it("selects the exact 90-day cutoff but excludes newer, unreviewed, and document-free rows", async () => {
    expect(RETENTION_DAYS).toBe(90);

    const onCutoff = await seedApplication({ reviewedAt: CUTOFF });
    await seedDocument(onCutoff.id);
    const oneMsNewer = await seedApplication({
      reviewedAt: new Date(CUTOFF.getTime() + 1),
    });
    await seedDocument(oneMsNewer.id);
    const withoutReviewedAt = await seedApplication({ reviewedAt: null });
    await seedDocument(withoutReviewedAt.id);
    const withoutDocuments = await seedApplication({
      reviewedAt: new Date(CUTOFF.getTime() - 1),
    });

    const selected = await selectExpiredApplications(prisma, NOW);
    const fixtureIds = new Set([
      onCutoff.id,
      oneMsNewer.id,
      withoutReviewedAt.id,
      withoutDocuments.id,
    ]);
    expect(selected.filter((candidate) => fixtureIds.has(candidate.id))).toEqual([
      { id: onCutoff.id, reference: onCutoff.reference },
    ]);

    await deleteKycDocuments(onCutoff.id, prisma);
  });

  it("never selects or touches old APPROVED, SUBMITTED, or INFO_REQUESTED documents", async () => {
    const fixtures = [];
    for (const status of ["APPROVED", "SUBMITTED", "INFO_REQUESTED"] as const) {
      const application = await seedApplication({
        status,
        reviewedAt: new Date(CUTOFF.getTime() - 24 * 60 * 60 * 1000),
      });
      const { document } = await seedDocument(application.id);
      fixtures.push({ application, document });
    }

    const fixtureIds = new Set(fixtures.map(({ application }) => application.id));
    const selected = await selectExpiredApplications(prisma, NOW);
    expect(selected.some((candidate) => fixtureIds.has(candidate.id))).toBe(false);
    expect(await runRetentionSweep(prisma, NOW)).toBe(0);

    for (const { application, document } of fixtures) {
      expect(
        await prisma.partnerDocument.count({ where: { applicationId: application.id } }),
      ).toBe(1);
      expect(await prisma.partnerApplication.findUnique({ where: { id: application.id } })).toBeTruthy();
      await expect(fsp.stat(document.storagePath)).resolves.toBeTruthy();
    }
  });

  it("deletes real files and rows, retains the application, and audits only reference and counts", async () => {
    const application = await seedApplication({
      reviewedAt: new Date(CUTOFF.getTime() - 1000),
      decisionNote: "Private review note Retention Zeta",
    });
    const first = await seedDocument(
      application.id,
      "TRADE_LICENCE",
      "Applicant-Licence-Retention-Zeta.pdf",
    );
    const second = await seedDocument(
      application.id,
      "SIGNATORY_ID",
      "Applicant-Identity-Retention-Zeta.pdf",
    );

    expect(await runRetentionSweep(prisma, NOW)).toBe(1);

    await expect(fsp.stat(first.dir)).rejects.toThrow();
    expect(
      await prisma.partnerDocument.count({ where: { applicationId: application.id } }),
    ).toBe(0);
    expect(await prisma.partnerApplication.findUnique({ where: { id: application.id } })).toBeTruthy();

    const auditRows = await prisma.log.findMany({
      where: { action: EXPIRED_ACTION, details: { contains: application.reference } },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].userId).toBeNull();
    expect(auditRows[0].details).toBe(`${application.reference} (2 file(s), 2 row(s))`);

    const personalData = [
      application.companyLegalName,
      application.tradingName,
      application.address,
      application.licenceNumber,
      application.contactName,
      application.contactEmail,
      application.contactPhone,
      application.decisionNote,
      first.document.originalName,
      second.document.originalName,
      first.document.storagePath,
      second.document.storagePath,
      first.dir,
    ].filter((value): value is string => value !== null);
    for (const value of personalData) {
      expect(auditRows[0].details).not.toContain(value);
    }
  });

  it("returns zero on an idempotent second run without another deletion call or audit row", async () => {
    const application = await seedApplication();
    await seedDocument(application.id);
    const deleteDocuments = vi.fn(
      async (
        applicationId: string,
        db?: Parameters<typeof deleteKycDocuments>[1],
        baseDir?: string,
      ) => deleteKycDocuments(applicationId, db, baseDir),
    );

    expect(await runRetentionSweep(prisma, NOW, { deleteDocuments })).toBe(1);
    expect(deleteDocuments).toHaveBeenCalledTimes(1);
    expect(deleteDocuments.mock.calls[0][0]).toBe(application.id);
    expect(deleteDocuments.mock.calls[0][1]).toBe(prisma);
    const auditCount = await prisma.log.count({ where: { action: EXPIRED_ACTION } });

    expect(await runRetentionSweep(prisma, NOW, { deleteDocuments })).toBe(0);
    expect(deleteDocuments).toHaveBeenCalledTimes(1);
    expect(await prisma.log.count({ where: { action: EXPIRED_ACTION } })).toBe(auditCount);
  });

  it("isolates one application's deletion failure and retries it on a later sweep", async () => {
    const failed = await seedApplication();
    const failedDocument = await seedDocument(failed.id);
    const successful = await seedApplication();
    const successfulDocument = await seedDocument(successful.id);

    const deleteDocuments = vi.fn(
      async (
        applicationId: string,
        db?: Parameters<typeof deleteKycDocuments>[1],
        baseDir?: string,
      ) => {
        if (applicationId === failed.id) throw new Error("injected retention failure");
        return deleteKycDocuments(applicationId, db, baseDir);
      },
    );

    expect(await runRetentionSweep(prisma, NOW, { deleteDocuments })).toBe(1);
    expect(deleteDocuments).toHaveBeenCalledTimes(2);
    expect(deleteDocuments.mock.calls.map(([applicationId]) => applicationId).sort()).toEqual(
      [failed.id, successful.id].sort(),
    );

    expect(await prisma.partnerDocument.count({ where: { applicationId: failed.id } })).toBe(1);
    await expect(fsp.stat(failedDocument.document.storagePath)).resolves.toBeTruthy();
    expect(await prisma.partnerDocument.count({ where: { applicationId: successful.id } })).toBe(0);
    await expect(fsp.stat(successfulDocument.dir)).rejects.toThrow();

    const failedAudits = await prisma.log.findMany({
      where: { action: EXPIRED_ACTION, details: { contains: failed.reference } },
    });
    const successfulAudits = await prisma.log.findMany({
      where: { action: EXPIRED_ACTION, details: { contains: successful.reference } },
    });
    expect(failedAudits).toHaveLength(0);
    expect(successfulAudits).toHaveLength(1);
    expect(successfulAudits[0].details).toBe(`${successful.reference} (1 file(s), 1 row(s))`);

    expect(await runRetentionSweep(prisma, NOW)).toBe(1);
    expect(await prisma.partnerDocument.count({ where: { applicationId: failed.id } })).toBe(0);
    await expect(fsp.stat(failedDocument.dir)).rejects.toThrow();
  });
});
