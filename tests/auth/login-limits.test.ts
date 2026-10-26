/**
 * Tests for the W7b sign-in throttling (lib/security/login-limits.ts). The
 * injected counter is an in-memory fake matching the LoginAttemptCounter
 * interface, so no database is needed. Hash helpers are checked against
 * manually computed sha256 digests (node:crypto) and the x-forwarded-for
 * parser against both plain objects (what NextAuth hands authorize()) and
 * Headers instances.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// Must be set before the module's hash helpers run (they read it per call).
process.env.NEXTAUTH_SECRET = String("login-limits-test-secret-min-32-characters!");

import {
  LOGIN_ACCOUNT_WINDOW_MS,
  LOGIN_IP_WINDOW_MS,
  MAX_LOGIN_FAILURES_PER_ACCOUNT,
  MAX_LOGIN_FAILURES_PER_IP,
  SECURITY_REQUEST_KIND_LOGIN_FAIL,
  checkLoginLimits,
  clientIpFromSignInHeaders,
  hashLoginEmail,
  hashLoginIp,
  type LoginAttemptCounter,
} from "@/lib/security/login-limits";

interface Row {
  kind: string;
  subjectHash: string;
  ipHash: string;
  createdAt: Date;
}

/** Mirrors the where shapes checkLoginLimits issues. */
function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
  if (typeof where.kind === "string" && row.kind !== where.kind) return false;
  if (typeof where.ipHash === "string" && row.ipHash !== where.ipHash) return false;
  if (typeof where.subjectHash === "string" && row.subjectHash !== where.subjectHash) return false;
  const createdAt = where.createdAt as { gte?: Date } | undefined;
  if (createdAt?.gte && row.createdAt < createdAt.gte) return false;
  return true;
}

function fakeCounter(rows: Row[]): LoginAttemptCounter {
  return {
    securityRequest: {
      count: async ({ where }) => rows.filter((row) => matchesWhere(row, where)).length,
    },
  };
}

function failRow(overrides: Partial<Row>): Row {
  return {
    kind: SECURITY_REQUEST_KIND_LOGIN_FAIL,
    subjectHash: "email-hash-a",
    ipHash: "ip-hash-a",
    createdAt: NOW,
    ...overrides,
  };
}

const NOW = new Date("2026-10-05T12:00:00.000Z");
const MINUTES = 60 * 1000;

const SUBJECT = { subjectHash: "email-hash-a", ipHash: "ip-hash-a" };

describe("checkLoginLimits — per hashed account", () => {
  it("allows attempts below the account quota", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT - 1 }, () => failRow({}));
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toBeNull();
  });

  it("throttles the account at the quota, reporting the first hit", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT }, () => failRow({}));
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toEqual({ limit: "account", firstHit: true });
  });

  it("reports firstHit false once the account is already over the quota", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT + 1 }, () => failRow({}));
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toEqual({ limit: "account", firstHit: false });
  });

  it("ignores failures older than the account window", async () => {
    const stale = new Date(NOW.getTime() - LOGIN_ACCOUNT_WINDOW_MS - 1 * MINUTES);
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT }, () => failRow({ createdAt: stale }));
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toBeNull();
  });

  it("does not count other accounts against this one", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT }, () =>
      failRow({ subjectHash: "email-hash-b" }),
    );
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toBeNull();
  });

  it("does not count rows of other kinds toward the login quotas", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_ACCOUNT }, () =>
      failRow({ kind: "PASSWORD_RESET_REQUEST" }),
    );
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toBeNull();
  });
});

describe("checkLoginLimits — per hashed IP", () => {
  // IP-quota rows use a DISTINCT subjectHash each so the tighter per-account
  // quota (checked first) never trips on them.
  it("allows attempts below the IP quota", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP - 1 }, (_, i) =>
      failRow({ subjectHash: `email-hash-ip-${i}` }),
    );
    const result = await checkLoginLimits(
      fakeCounter(rows),
      { subjectHash: "email-hash-new", ipHash: "ip-hash-a" },
      NOW,
    );
    expect(result).toBeNull();
  });

  it("throttles the IP at the quota, reporting the first hit", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP }, (_, i) =>
      failRow({ subjectHash: `email-hash-ip-${i}` }),
    );
    const result = await checkLoginLimits(
      fakeCounter(rows),
      { subjectHash: "email-hash-new", ipHash: "ip-hash-a" },
      NOW,
    );
    expect(result).toEqual({ limit: "ip", firstHit: true });
  });

  it("reports firstHit false once the IP is already over the quota", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP + 1 }, (_, i) =>
      failRow({ subjectHash: `email-hash-ip-${i}` }),
    );
    const result = await checkLoginLimits(
      fakeCounter(rows),
      { subjectHash: "email-hash-new", ipHash: "ip-hash-a" },
      NOW,
    );
    expect(result).toEqual({ limit: "ip", firstHit: false });
  });

  it("ignores failures older than the IP window", async () => {
    const stale = new Date(NOW.getTime() - LOGIN_IP_WINDOW_MS - 1 * MINUTES);
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP }, (_, i) =>
      failRow({ subjectHash: `email-hash-ip-${i}`, createdAt: stale }),
    );
    const result = await checkLoginLimits(
      fakeCounter(rows),
      { subjectHash: "email-hash-new", ipHash: "ip-hash-a" },
      NOW,
    );
    expect(result).toBeNull();
  });

  it("does not count other IPs against this one", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP }, (_, i) =>
      failRow({ subjectHash: `email-hash-ip-${i}`, ipHash: "ip-hash-b" }),
    );
    const result = await checkLoginLimits(
      fakeCounter(rows),
      { subjectHash: "email-hash-new", ipHash: "ip-hash-a" },
      NOW,
    );
    expect(result).toBeNull();
  });

  it("reports the account limit before the IP limit when both are hit", async () => {
    const rows = Array.from({ length: MAX_LOGIN_FAILURES_PER_IP }, () => failRow({}));
    const result = await checkLoginLimits(fakeCounter(rows), SUBJECT, NOW);
    expect(result).toEqual({ limit: "account", firstHit: false });
  });
});

describe("hashLoginEmail", () => {
  it("matches a manually computed sha256 of the salted normalised email", () => {
    const expected = createHash("sha256")
      .update(`login-email:${process.env.NEXTAUTH_SECRET}:user@example.com`)
      .digest("hex");
    expect(hashLoginEmail("user@example.com")).toBe(expected);
  });

  it("normalises case and surrounding whitespace into one quota bucket", () => {
    expect(hashLoginEmail("  User@Example.COM  ")).toBe(hashLoginEmail("user@example.com"));
  });

  it("throws when NEXTAUTH_SECRET is unset (fails closed)", () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      expect(() => hashLoginEmail("user@example.com")).toThrow();
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });

  it("differs from hashLoginIp of the same string (purpose separation)", () => {
    expect(hashLoginEmail("203.0.113.9")).not.toBe(hashLoginIp("203.0.113.9"));
  });
});

describe("hashLoginIp", () => {
  it("matches a manually computed sha256 of the salted IP", () => {
    const expected = createHash("sha256")
      .update(`login-ip:${process.env.NEXTAUTH_SECRET}:203.0.113.9`)
      .digest("hex");
    expect(hashLoginIp("203.0.113.9")).toBe(expected);
  });

  it("throws when NEXTAUTH_SECRET is unset (fails closed)", () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      expect(() => hashLoginIp("203.0.113.9")).toThrow();
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });
});

describe("clientIpFromSignInHeaders", () => {
  it("reads x-forwarded-for from a plain object (the NextAuth authorize shape)", () => {
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
  });

  it("keeps only the first hop of a multi-hop chain", () => {
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
  });

  it("trims surrounding whitespace", () => {
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": "  203.0.113.9  " })).toBe("203.0.113.9");
  });

  it("reads from a Headers instance (the route-handler shape)", () => {
    expect(clientIpFromSignInHeaders(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
  });

  it("takes the first entry of an array value", () => {
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": ["203.0.113.9"] })).toBe("203.0.113.9");
  });

  it("falls back to the shared unknown bucket when the header is missing or empty", () => {
    expect(clientIpFromSignInHeaders({})).toBe("unknown");
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": "" })).toBe("unknown");
    expect(clientIpFromSignInHeaders({ "x-forwarded-for": undefined })).toBe("unknown");
  });

  it("falls back to unknown when no headers are passed at all", () => {
    expect(clientIpFromSignInHeaders(undefined)).toBe("unknown");
  });
});
