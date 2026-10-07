/**
 * Tests for the W6a request limits (lib/security/limits.ts). The injected
 * counter is an in-memory fake matching the SecurityRequestCounter interface,
 * so no database is needed.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR,
  MAX_RESET_REQUESTS_PER_DAY_GLOBAL,
  MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR,
  MAX_RESET_REQUESTS_PER_IP_PER_HOUR,
  SECURITY_REQUEST_KIND_CONFIRM,
  SECURITY_REQUEST_KIND_REQUEST,
  checkConfirmLimits,
  checkRequestLimits,
  type SecurityRequestCounter,
} from "@/lib/security/limits";

interface Row {
  kind: string;
  subjectHash: string;
  ipHash: string;
  createdAt: Date;
}

/** Mirrors the where shapes checkRequestLimits / checkConfirmLimits issue. */
function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  if (typeof where.kind === "string" && row.kind !== where.kind) return false;
  if (typeof where.ipHash === "string" && row.ipHash !== where.ipHash) return false;
  if (typeof where.subjectHash === "string" && row.subjectHash !== where.subjectHash) return false;
  const createdAt = where.createdAt as { gte?: Date } | undefined;
  if (createdAt?.gte && row.createdAt < createdAt.gte) return false;
  return true;
}

function fakeCounter(rows: Row[]): SecurityRequestCounter {
  return {
    securityRequest: {
      count: async ({ where }) => rows.filter((row) => matchesWhere(row, where)).length,
    },
  };
}

function requestRow(overrides: Partial<Row>): Row {
  return {
    kind: SECURITY_REQUEST_KIND_REQUEST,
    subjectHash: "email-hash-a",
    ipHash: "ip-hash-a",
    createdAt: NOW,
    ...overrides,
  };
}

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MINUTES = 60 * 1000;

describe("checkRequestLimits — per hashed IP", () => {
  it("allows requests up to the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR - 1 }, () => requestRow({}));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBeNull();
  });

  it("refuses the request beyond the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR }, () => requestRow({}));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBe("ip");
  });

  it("ignores requests older than the rolling hour", async () => {
    const stale = new Date(NOW.getTime() - 61 * MINUTES);
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR }, () => requestRow({ createdAt: stale }));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBeNull();
  });

  it("does not count other IPs against this one", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR }, () => requestRow({ ipHash: "ip-hash-b" }));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBeNull();
  });
});

describe("checkRequestLimits — per hashed email", () => {
  it("allows requests up to the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR - 1 }, () => requestRow({}));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-a" }, NOW);
    expect(result).toBeNull();
  });

  it("refuses the request beyond the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR }, () => requestRow({}));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-a" }, NOW);
    expect(result).toBe("email");
  });

  it("does not count other emails against this one", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR }, () =>
      requestRow({ subjectHash: "email-hash-b" }),
    );
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-a" }, NOW);
    expect(result).toBeNull();
  });

  it("reports the per-IP limit before the per-email limit when both are hit", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR }, () => requestRow({}));
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-a" }, NOW);
    expect(result).toBe("ip");
  });
});

describe("checkRequestLimits — global per day", () => {
  it("allows requests below the daily quota", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_DAY_GLOBAL - 1 }, (_, i) =>
      requestRow({ ipHash: `ip-hash-${i}`, subjectHash: `email-hash-${i}` }),
    );
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBeNull();
  });

  it("refuses requests once the daily quota is reached", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_DAY_GLOBAL }, (_, i) =>
      requestRow({ ipHash: `ip-hash-${i}`, subjectHash: `email-hash-${i}` }),
    );
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBe("day");
  });

  it("ignores requests from the previous UTC day", async () => {
    const yesterday = new Date(Date.UTC(2026, 9, 4, 23, 59, 59));
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_DAY_GLOBAL }, (_, i) =>
      requestRow({ ipHash: `ip-hash-${i}`, subjectHash: `email-hash-${i}`, createdAt: yesterday }),
    );
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-new", subjectHash: "email-hash-new" }, NOW);
    expect(result).toBeNull();
  });

  it("does not count confirm attempts toward the request quotas", async () => {
    const rows = Array.from({ length: MAX_RESET_REQUESTS_PER_IP_PER_HOUR }, () =>
      requestRow({ kind: SECURITY_REQUEST_KIND_CONFIRM }),
    );
    const result = await checkRequestLimits(fakeCounter(rows), { ipHash: "ip-hash-a", subjectHash: "email-hash-a" }, NOW);
    expect(result).toBeNull();
  });
});

describe("checkConfirmLimits — per hashed IP", () => {
  it("allows attempts up to the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR - 1 }, () =>
      requestRow({ kind: SECURITY_REQUEST_KIND_CONFIRM }),
    );
    expect(await checkConfirmLimits(fakeCounter(rows), "ip-hash-a", NOW)).toBeNull();
  });

  it("refuses attempts beyond the hourly quota", async () => {
    const rows = Array.from({ length: MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR }, () =>
      requestRow({ kind: SECURITY_REQUEST_KIND_CONFIRM }),
    );
    expect(await checkConfirmLimits(fakeCounter(rows), "ip-hash-a", NOW)).toBe("ip");
  });

  it("ignores attempts older than the rolling hour and from other IPs", async () => {
    const stale = new Date(NOW.getTime() - 61 * MINUTES);
    const rows = [
      ...Array.from({ length: MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR }, () =>
        requestRow({ kind: SECURITY_REQUEST_KIND_CONFIRM, createdAt: stale }),
      ),
      ...Array.from({ length: MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR }, () =>
        requestRow({ kind: SECURITY_REQUEST_KIND_CONFIRM, ipHash: "ip-hash-b" }),
      ),
    ];
    expect(await checkConfirmLimits(fakeCounter(rows), "ip-hash-a", NOW)).toBeNull();
  });

  it("does not count reset requests toward the confirm quota", async () => {
    const rows = Array.from({ length: MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR }, () => requestRow({}));
    expect(await checkConfirmLimits(fakeCounter(rows), "ip-hash-a", NOW)).toBeNull();
  });
});
