/**
 * Partner reference generation (lib/partners/reference.ts): PA-YYYY-NNNN.
 *
 * - The first reference for a year with no rows is PA-<year>-0001 and matches
 *   PARTNER_REFERENCE_PATTERN.
 * - The sequence increments per created row and is scoped per year.
 * - Padding is a minimum: after PA-<year>-9999 the next value grows to
 *   PA-<year>-10000 (no truncation).
 * - parsePartnerReference round-trips valid references and rejects malformed
 *   ones (short years, short sequences, wrong prefixes, empty strings).
 * - nextPartnerReference only PROPOSES a value: concurrent creators can
 *   propose the same reference and the unique index decides. The create
 *   helper retries on P2002 (bounded), and N concurrent workers end up with
 *   N distinct, exactly sequential references.
 *
 * Far-future years (2099+) are used so the shared per-file database can
 * never clash with real or other-suite data.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  PARTNER_REFERENCE_PATTERN,
  nextPartnerReference,
  parsePartnerReference,
} from "@/lib/partners/reference";

let prisma: PrismaClient;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
});

function applicationData(reference: string) {
  return {
    reference,
    companyLegalName: `Test Company ${reference}`,
    country: "AE",
    city: "Dubai",
    address: "1 Test Street",
    licenceNumber: `LIC-${reference}`,
    licenceAuthority: "DET",
    licenceExpiry: "2030-01-01",
    contactName: "Test Contact",
    contactEmail: `contact-${reference.toLowerCase()}@example.com`,
    contactPhone: "+971500000000",
    consentKyc: true,
    consentChannels: true,
    consentVersion: "v1",
    ipHash: `iphash-${reference}`,
  };
}

async function createApplication(reference: string) {
  return prisma.partnerApplication.create({ data: applicationData(reference) });
}

/**
 * Propose-then-create with bounded P2002 retries: the unique index on
 * `reference` is the real guard when concurrent proposals collide.
 */
async function createForYear(year: number, maxAttempts = 10) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const reference = await nextPartnerReference(prisma, year);
    try {
      return await createApplication(reference);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        continue;
      }
      throw e;
    }
  }
  throw new Error(`could not create a PartnerApplication for ${year} after ${maxAttempts} attempts`);
}

describe("nextPartnerReference", () => {
  it("starts a fresh year at PA-<year>-0001, matching the pattern", async () => {
    const reference = await nextPartnerReference(prisma, 2099);
    expect(reference).toBe("PA-2099-0001");
    expect(reference).toMatch(PARTNER_REFERENCE_PATTERN);
  });

  it("increments sequentially as rows are created", async () => {
    await createApplication(await nextPartnerReference(prisma, 2099));
    expect(await nextPartnerReference(prisma, 2099)).toBe("PA-2099-0002");
    await createApplication(await nextPartnerReference(prisma, 2099));
    expect(await nextPartnerReference(prisma, 2099)).toBe("PA-2099-0003");
  });

  it("scopes sequences per year", async () => {
    // 2099 already has rows from the tests above; 2100 must start fresh.
    expect(await nextPartnerReference(prisma, 2100)).toBe("PA-2100-0001");
  });

  it("grows the sequence beyond 9999 without truncation", async () => {
    await createApplication("PA-2101-9999");
    const reference = await nextPartnerReference(prisma, 2101);
    expect(reference).toBe("PA-2101-10000");
    expect(reference).toMatch(PARTNER_REFERENCE_PATTERN);
  });

  it("produces 10 distinct, sequential references for 10 concurrent creators", async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, () => createForYear(2102)),
    );
    expect(created).toHaveLength(10);

    const references = created.map((a) => a.reference);
    expect(new Set(references).size).toBe(10);
    for (const reference of references) {
      expect(reference).toMatch(PARTNER_REFERENCE_PATTERN);
    }

    const expected = Array.from(
      { length: 10 },
      (_, i) => `PA-2102-${String(i + 1).padStart(4, "0")}`,
    );
    expect([...references].sort()).toEqual(expected);

    // The next proposal continues past the burst without reuse.
    expect(await nextPartnerReference(prisma, 2102)).toBe("PA-2102-0011");
  }, 60000);
});

describe("parsePartnerReference", () => {
  it("parses a valid reference into year and numeric sequence", () => {
    expect(parsePartnerReference("PA-2026-0042")).toEqual({ year: 2026, seq: 42 });
  });

  it("parses sequences wider than 4 digits", () => {
    expect(parsePartnerReference("PA-2101-10000")).toEqual({ year: 2101, seq: 10000 });
  });

  it("returns null for malformed references", () => {
    expect(parsePartnerReference("PA-2026-042")).toBeNull();
    expect(parsePartnerReference("PA-26-0001")).toBeNull();
    expect(parsePartnerReference("PA-2026")).toBeNull();
    expect(parsePartnerReference("")).toBeNull();
    expect(parsePartnerReference("XX-2026-0001")).toBeNull();
  });
});
