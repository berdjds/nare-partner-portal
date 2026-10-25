/**
 * Sign-in throttling (W7b, REQ-2026-0008) in the credentials authorize path.
 *
 * Contract under test (see lib/security/login-limits.ts and lib/auth.ts):
 *
 * - Failed attempts are recorded as SecurityRequest rows (kind LOGIN_FAIL)
 *   keyed by the HASHED account email and HASHED client IP only — raw values
 *   never reach the database.
 * - After MAX_LOGIN_FAILURES_PER_ACCOUNT (8) failures in 15 minutes for one
 *   account, or MAX_LOGIN_FAILURES_PER_IP (30) in an hour for one client IP,
 *   authorize() returns null WITHOUT checking the password — the exact same
 *   outcome as a wrong password. Unknown emails are throttled the same way.
 * - The first throttled attempt per window writes one LOGIN_THROTTLED audit
 *   row carrying hashed identifiers only; later attempts in the same window
 *   add no further audit rows.
 * - A successful sign-in clears the account's counter (the shared per-IP
 *   counter is untouched).
 * - The whole throttle layer fails open: with NEXTAUTH_SECRET unset (hashing
 *   throws), sign-ins behave exactly as before and nothing is recorded.
 *
 * Hermetic setup: DATABASE_URL points at a throwaway SQLite file (shared
 * travel-db helpers) and authorize() runs for real, bcrypt included — the
 * same pattern as tests/auth/auth.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// Must be set before @/lib/auth (and its login-limits import) is loaded.
process.env.NEXTAUTH_SECRET = String("login-throttle-test-secret-min-32-characters!");

import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  MAX_LOGIN_FAILURES_PER_ACCOUNT,
  MAX_LOGIN_FAILURES_PER_IP,
  SECURITY_REQUEST_KIND_LOGIN_FAIL,
  hashLoginEmail,
  hashLoginIp,
} from "@/lib/security/login-limits";

const CORRECT = "correct horse battery staple";
const WRONG = "definitely not the right password";

let prisma: PrismaClient;
let authOptions: typeof import("@/lib/auth").authOptions;

/**
 * The credentials provider as next-auth's parseProviders() normalizes it —
 * the same unwrapping tests/auth/auth.test.ts documents: the user-supplied
 * authorize lives under `.options` and is merged over the provider at request
 * time.
 */
function credentialsProvider(): {
  authorize: (credentials: unknown, req?: unknown) => Promise<unknown>;
} {
  const { options, ...rest } = authOptions.providers[0] as any;
  return { ...rest, ...options };
}

let ipCounter = 0;
/** Fresh TEST-NET-2 address per call so per-IP quotas stay isolated. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

let emailCounter = 0;
function uniqueEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}-${emailCounter}@throttle.test`;
}

/** NextAuth hands authorize() the request headers as a plain object. */
function authorize(email: string, password: string, ip: string) {
  return credentialsProvider().authorize(
    { email, password },
    { headers: { "x-forwarded-for": ip } },
  );
}

async function createUser(email: string): Promise<{ id: string; email: string }> {
  const user = await prisma.user.create({
    data: { email, name: "Throttle Test", password: bcrypt.hashSync(CORRECT, 10), role: "USER" },
  });
  return { id: user.id, email: user.email };
}

function failureCount(where: { subjectHash?: string; ipHash?: string }): Promise<number> {
  return prisma.securityRequest.count({
    where: { kind: SECURITY_REQUEST_KIND_LOGIN_FAIL, ...where },
  });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  authOptions = (await import("@/lib/auth")).authOptions;
});

describe("credentials authorize() — sign-in throttling (W7b)", () => {
  it("records each failed attempt as a LOGIN_FAIL row with hashes only", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("record"));

    expect(await authorize(user.email, WRONG, ip)).toBeNull();

    const rows = await prisma.securityRequest.findMany({
      where: { kind: SECURITY_REQUEST_KIND_LOGIN_FAIL, subjectHash: hashLoginEmail(user.email) },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectHash).toBe(hashLoginEmail(user.email));
    expect(rows[0].ipHash).toBe(hashLoginIp(ip));
    // Hashes only: 64-char hex that contains neither the raw email nor the IP.
    expect(rows[0].subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].subjectHash).not.toContain(user.email);
    expect(rows[0].ipHash).not.toContain(ip);
  });

  it("checks the password normally through the 8th attempt (boundary: not yet throttled)", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("boundary-low"));

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT - 1; i += 1) {
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
    }
    expect(await failureCount({ subjectHash: hashLoginEmail(user.email) })).toBe(
      MAX_LOGIN_FAILURES_PER_ACCOUNT - 1,
    );

    // Attempt 8 still reaches the password check — and succeeds.
    const result: any = await authorize(user.email, CORRECT, ip);
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
  });

  it("throttles the 9th attempt after 8 failures, without checking the password", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("boundary-high"));

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT; i += 1) {
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
    }
    expect(await failureCount({ subjectHash: hashLoginEmail(user.email) })).toBe(
      MAX_LOGIN_FAILURES_PER_ACCOUNT,
    );

    // Attempt 9: the CORRECT password is refused, proving it was never checked.
    expect(await authorize(user.email, CORRECT, ip)).toBeNull();
    // The throttled attempt itself is recorded, keeping the counters honest.
    expect(await failureCount({ subjectHash: hashLoginEmail(user.email) })).toBe(
      MAX_LOGIN_FAILURES_PER_ACCOUNT + 1,
    );
  });

  it("gives a throttled attempt the identical outcome to a wrong password: null", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("identical"));

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT; i += 1) {
      await authorize(user.email, WRONG, ip);
    }
    const throttled = await authorize(user.email, CORRECT, ip);
    const wrongPassword = await credentialsProvider().authorize(
      { email: uniqueEmail("identical-fresh"), password: WRONG },
      { headers: { "x-forwarded-for": nextIp() } },
    );
    expect(throttled).toBeNull();
    expect(throttled).toEqual(wrongPassword);
  });

  it("writes one LOGIN_THROTTLED audit row (hashes only) when the limit is first hit", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("audit"));
    const subjectHash = hashLoginEmail(user.email);
    const ipHash = hashLoginIp(ip);

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT; i += 1) {
      await authorize(user.email, WRONG, ip);
    }
    // Attempts 9 and 10 are both throttled; only the first one audits.
    await authorize(user.email, WRONG, ip);
    await authorize(user.email, WRONG, ip);

    const logs = await prisma.log.findMany({
      where: { action: "LOGIN_THROTTLED", details: { contains: subjectHash } },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBeNull();
    expect(logs[0].details).toContain(ipHash);
    expect(logs[0].details).not.toContain(user.email);
    expect(logs[0].details).not.toContain(ip);
  });

  it("throttles unknown emails the same way as known accounts", async () => {
    const ip = nextIp();
    const unknown = uniqueEmail("nobody");
    const subjectHash = hashLoginEmail(unknown);

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT; i += 1) {
      expect(await authorize(unknown, WRONG, ip)).toBeNull();
    }
    // Failures were recorded for an email that has no account at all.
    expect(await failureCount({ subjectHash })).toBe(MAX_LOGIN_FAILURES_PER_ACCOUNT);

    // The next attempt is throttled: the first-hit audit row appears.
    await authorize(unknown, WRONG, ip);
    const logs = await prisma.log.findMany({
      where: { action: "LOGIN_THROTTLED", details: { contains: subjectHash } },
    });
    expect(logs).toHaveLength(1);
  });

  it("enforces the per-IP quota across accounts", async () => {
    const ip = nextIp();
    const ipHash = hashLoginIp(ip);

    // Spread the failures over many accounts so only the IP quota can engage.
    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_IP; i += 1) {
      expect(await authorize(uniqueEmail("ip-quota"), WRONG, ip)).toBeNull();
    }
    expect(await failureCount({ ipHash })).toBe(MAX_LOGIN_FAILURES_PER_IP);

    // A fresh account with the CORRECT password is refused from this IP...
    const user = await createUser(uniqueEmail("ip-victim"));
    expect(await authorize(user.email, CORRECT, ip)).toBeNull();

    const logs = await prisma.log.findMany({
      where: { action: "LOGIN_THROTTLED", details: { contains: ipHash } },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].details).toContain("ip");

    // ...but signs in fine from a different address (account counter is clean).
    const result: any = await authorize(user.email, CORRECT, nextIp());
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
  });

  it("ignores failures older than the rolling 15-minute account window", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("window"));
    const subjectHash = hashLoginEmail(user.email);
    const stale = new Date(Date.now() - 16 * 60 * 1000);

    for (let i = 0; i < MAX_LOGIN_FAILURES_PER_ACCOUNT; i += 1) {
      await prisma.securityRequest.create({
        data: {
          kind: SECURITY_REQUEST_KIND_LOGIN_FAIL,
          subjectHash,
          ipHash: hashLoginIp(ip),
          createdAt: stale,
        },
      });
    }

    // 8 stale failures must not throttle: the correct password still works.
    const result: any = await authorize(user.email, CORRECT, ip);
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
  });

  it("clears only the account's counter on a successful sign-in", async () => {
    const ip = nextIp();
    const ipHash = hashLoginIp(ip);
    const userA = await createUser(uniqueEmail("clear-a"));
    const userB = await createUser(uniqueEmail("clear-b"));
    const hashA = hashLoginEmail(userA.email);
    const hashB = hashLoginEmail(userB.email);

    for (let i = 0; i < 3; i += 1) await authorize(userA.email, WRONG, ip);
    for (let i = 0; i < 2; i += 1) await authorize(userB.email, WRONG, ip);
    expect(await failureCount({ subjectHash: hashA })).toBe(3);
    expect(await failureCount({ subjectHash: hashB })).toBe(2);

    const result: any = await authorize(userA.email, CORRECT, ip);
    expect(result).not.toBeNull();

    // A's counter is gone; B's failures on the same IP are untouched.
    expect(await failureCount({ subjectHash: hashA })).toBe(0);
    expect(await failureCount({ subjectHash: hashB })).toBe(2);
    expect(await failureCount({ ipHash })).toBe(2);

    // And A can fail again from a clean counter.
    expect(await authorize(userA.email, WRONG, ip)).toBeNull();
    expect(await failureCount({ subjectHash: hashA })).toBe(1);
  });

  it("fails open when the throttle layer faults: no hashing secret, no throttling, no recording", async () => {
    const ip = nextIp();
    const user = await createUser(uniqueEmail("fail-open"));
    // Computed while the secret is still set; hashing inside authorize()
    // will throw once it is unset, which is exactly the fault under test.
    const subjectHash = hashLoginEmail(user.email);

    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      // Correct and wrong passwords behave exactly as without the throttle.
      const result: any = await authorize(user.email, CORRECT, ip);
      expect(result).not.toBeNull();
      expect(result.id).toBe(user.id);
      expect(await authorize(user.email, WRONG, ip)).toBeNull();
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }

    // Nothing was recorded for either attempt.
    expect(await failureCount({ subjectHash })).toBe(0);
  });
});
