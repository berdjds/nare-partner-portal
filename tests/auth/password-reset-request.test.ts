/**
 * POST /api/auth/password-reset/request (app/api/auth/password-reset/request/route.ts)
 * — W6a self-service password reset, step 1.
 *
 * Contract under test (see the route module header for the rationale):
 *
 * - ONE generic 200 body for every account state (active, unknown, inactive)
 *   and for the per-account limit; only the per-IP overflow is visible, as a
 *   generic 429. The honeypot field (PASSWORD_RESET_HONEYPOT_FIELD) answers
 *   the same 200 while doing no work at all. Unparseable/invalid bodies also
 *   get the generic 200.
 * - A PasswordResetToken row appears only for an ACTIVE account; issuing a
 *   new token invalidates the user's earlier unused ones (usedAt set). The
 *   emailed link carries the RAW token; the database stores only its sha256
 *   hash (lib/security/reset-token.ts) with a 30-minute expiry.
 * - Unknown emails still get SecurityRequest bookkeeping and an audit row so
 *   the work mirrors known accounts; audit and bookkeeping rows hold hashes
 *   only — never the raw email, IP or token.
 * - The email send is best-effort: a rejected sendEmail never changes the
 *   response.
 *
 * Hermetic setup: DATABASE_URL points at a throwaway SQLite file (shared
 * travel-db helpers), @/lib/email is mocked, and NEXTAUTH_SECRET /
 * NEXTAUTH_URL are set before the route module is imported.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Must be set before the route module (and lib/partners/abuse.ts hashing) runs.
process.env.NEXTAUTH_SECRET = String("password-reset-request-test-secret-32!");
process.env.NEXTAUTH_URL = String("http://localhost:3000");

import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR,
  MAX_RESET_REQUESTS_PER_IP_PER_HOUR,
  PASSWORD_RESET_HONEYPOT_FIELD,
  SECURITY_REQUEST_KIND_REQUEST,
  hashResetEmail,
} from "@/lib/security/limits";
import { hashResetToken } from "@/lib/security/reset-token";
import { sendEmail } from "@/lib/email";

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));

const sendEmailMock = vi.mocked(sendEmail);

let prisma: PrismaClient;
let POST: typeof import("@/app/api/auth/password-reset/request/route").POST;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  POST = (await import("@/app/api/auth/password-reset/request/route")).POST;
});

beforeEach(() => {
  sendEmailMock.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let ipCounter = 0;
/** Fresh TEST-NET-2 address per call so per-IP quotas stay isolated. */
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

let emailCounter = 0;
function uniqueEmail(prefix: string): string {
  emailCounter += 1;
  return `${prefix}-${Date.now()}-${emailCounter}@test.io`;
}

/** Generated at run time — tests must not carry credential-looking literals. */
function userPassword(): string {
  return `pw-${crypto.randomBytes(12).toString("hex")}`;
}

function seedUser(email: string, active: boolean) {
  return prisma.user.create({
    data: {
      email,
      name: "Reset Test User",
      password: bcrypt.hashSync(userPassword(), 10),
      role: "USER",
      active,
    },
  });
}

async function postRequest(body: unknown, ip: string = nextIp()) {
  return POST(
    new NextRequest("http://localhost:3000/api/auth/password-reset/request", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
    }),
  );
}

/** The raw token from the reset link in a mocked sendEmail call's text body. */
function tokenFromEmailText(text: string): string {
  const linkLine = text.split("\n").find((line) => line.startsWith("http"));
  expect(linkLine).toBeTruthy();
  const url = new URL(linkLine!);
  expect(url.origin).toBe("http://localhost:3000");
  expect(url.pathname).toBe("/reset-password");
  const token = url.searchParams.get("token");
  expect(token).toBeTruthy();
  return token!;
}

// ---------------------------------------------------------------------------
// Uniform 200 — no enumeration by account state
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/request — no enumeration", () => {
  it("answers the identical 200 body for active, unknown and inactive accounts", async () => {
    const active = await seedUser(uniqueEmail("reset-active"), true);
    const inactive = await seedUser(uniqueEmail("reset-inactive"), false);
    const unknownEmail = uniqueEmail("reset-unknown");

    const responses = await Promise.all([
      postRequest({ email: active.email }),
      postRequest({ email: inactive.email }),
      postRequest({ email: unknownEmail }),
    ]);
    const bodies = await Promise.all(responses.map((res) => res.json()));

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(responses[0].headers.get("content-type"));
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    // Only the active account triggers an email, and the body never says so.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe(active.email);
  });

  it("answers the same generic 200 for invalid emails and unparseable bodies", async () => {
    const reference = await (await postRequest({ email: uniqueEmail("reset-ref") })).json();
    const rowsBefore = await prisma.securityRequest.count();

    const invalidEmail = await postRequest({ email: "not-an-email" });
    expect(invalidEmail.status).toBe(200);
    expect(await invalidEmail.json()).toEqual(reference);

    const unparseable = await POST(
      new NextRequest("http://localhost:3000/api/auth/password-reset/request", {
        method: "POST",
        body: "not json",
        headers: { "content-type": "text/plain", "x-forwarded-for": nextIp() },
      }),
    );
    expect(unparseable.status).toBe(200);
    expect(await unparseable.json()).toEqual(reference);

    // Neither attempt reaches the bookkeeping stage.
    expect(await prisma.securityRequest.count()).toBe(rowsBefore);
  });

  it("answers the same 200 for a filled honeypot and sends nothing", async () => {
    const user = await seedUser(uniqueEmail("reset-honeypot"), true);
    const reference = await (await postRequest({ email: uniqueEmail("reset-ref2") })).json();
    sendEmailMock.mockClear();
    const rowsBefore = await prisma.securityRequest.count();
    const tokensBefore = await prisma.passwordResetToken.count({ where: { userId: user.id } });

    const res = await postRequest({
      email: user.email,
      [PASSWORD_RESET_HONEYPOT_FIELD]: "https://spam.example",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(reference);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await prisma.securityRequest.count()).toBe(rowsBefore);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(tokensBefore);
  });
});

// ---------------------------------------------------------------------------
// Token issuance
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/request — token issuance", () => {
  it("creates a token row only for an active account", async () => {
    const active = await seedUser(uniqueEmail("reset-token-active"), true);
    const inactive = await seedUser(uniqueEmail("reset-token-inactive"), false);

    // The table may hold rows from earlier tests in this file; what matters
    // is that inactive and unknown accounts add none.
    const tokensBefore = await prisma.passwordResetToken.count();
    await postRequest({ email: inactive.email });
    await postRequest({ email: uniqueEmail("reset-token-unknown") });
    expect(await prisma.passwordResetToken.count()).toBe(tokensBefore);

    const before = Date.now();
    await postRequest({ email: active.email });
    const after = Date.now();
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: active.id } });
    expect(tokens).toHaveLength(1);
    const token = tokens[0];
    expect(token.usedAt).toBeNull();
    expect(token.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // 30-minute lifetime. The expiry is stamped between `before` and `after`,
    // so measure the upper bound against `after` — using `before` would add
    // the request's own duration and flake by a few milliseconds.
    expect(token.expiresAt.getTime() - before).toBeGreaterThan(29 * 60 * 1000);
    expect(token.expiresAt.getTime() - after).toBeLessThanOrEqual(30 * 60 * 1000);

    expect(await prisma.passwordResetToken.count({ where: { userId: inactive.id } })).toBe(0);
  });

  it("issues a token and emails an active account stored with a mixed-case address", async () => {
    // Users keep the case they were registered with and log in with it, so
    // the request must match the stored address exactly (no lowercasing).
    emailCounter += 1;
    const storedEmail = `Partner.Mixed-${Date.now()}-${emailCounter}@Agency.test.io`;
    const user = await seedUser(storedEmail, true);

    const res = await postRequest({ email: storedEmail });
    expect(res.status).toBe(200);

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].usedAt).toBeNull();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe(storedEmail);

    // The per-account quota bucket is case-insensitive (hashResetEmail
    // lowercases internally), so the bookkeeping row hashes the same either
    // way.
    const row = await prisma.securityRequest.findFirst({
      where: { kind: SECURITY_REQUEST_KIND_REQUEST, subjectHash: hashResetEmail(storedEmail.toLowerCase()) },
    });
    expect(row).toBeTruthy();
  });

  it("mirrors bookkeeping for unknown and inactive emails (hashes only)", async () => {
    const unknownEmail = uniqueEmail("reset-book-unknown");
    const inactive = await seedUser(uniqueEmail("reset-book-inactive"), false);

    await postRequest({ email: unknownEmail });
    await postRequest({ email: inactive.email });

    for (const email of [unknownEmail, inactive.email]) {
      const row = await prisma.securityRequest.findFirst({
        where: { kind: SECURITY_REQUEST_KIND_REQUEST, subjectHash: hashResetEmail(email) },
      });
      expect(row).toBeTruthy();
      expect(row!.subjectHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.subjectHash).not.toContain(email);
      expect(row!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("invalidates earlier unused tokens when a new one is issued", async () => {
    const user = await seedUser(uniqueEmail("reset-rotate"), true);

    await postRequest({ email: user.email });
    await postRequest({ email: user.email });

    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tokens).toHaveLength(2);
    expect(tokens[0].usedAt).not.toBeNull();
    expect(tokens[1].usedAt).toBeNull();

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const firstToken = tokenFromEmailText(sendEmailMock.mock.calls[0][0].text);
    const secondToken = tokenFromEmailText(sendEmailMock.mock.calls[1][0].text);
    expect(firstToken).not.toBe(secondToken);
    expect(hashResetToken(firstToken)).toBe(tokens[0].tokenHash);
    expect(hashResetToken(secondToken)).toBe(tokens[1].tokenHash);
  });

  it("sends the raw token in the link while the database holds only its hash", async () => {
    const user = await seedUser(uniqueEmail("reset-raw"), true);

    await postRequest({ email: user.email });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mail = sendEmailMock.mock.calls[0][0];
    expect(mail.to).toBe(user.email);
    expect(mail.text).toContain("30 minutes");
    expect(mail.text.toLowerCase()).toContain("ignore");

    const rawToken = tokenFromEmailText(mail.text);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].tokenHash).toBe(hashResetToken(rawToken));
    expect(tokens[0].tokenHash).not.toBe(rawToken);
  });
});

// ---------------------------------------------------------------------------
// Request limits
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/request — limits", () => {
  it("per-account limit keeps the same 200 body but silently stops sending", async () => {
    const user = await seedUser(uniqueEmail("reset-limited"), true);
    const reference = await (await postRequest({ email: uniqueEmail("reset-ref3") })).json();
    sendEmailMock.mockClear();

    for (let i = 0; i < MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR; i += 1) {
      const res = await postRequest({ email: user.email });
      expect(res.status).toBe(200);
    }
    expect(sendEmailMock).toHaveBeenCalledTimes(MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR);

    const overLimit = await postRequest({ email: user.email });
    expect(overLimit.status).toBe(200);
    expect(await overLimit.json()).toEqual(reference);
    expect(sendEmailMock).toHaveBeenCalledTimes(MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR);

    // No fourth token, and the last issued one stays untouched.
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR);
    expect(tokens.filter((token) => token.usedAt === null)).toHaveLength(1);
  });

  it("per-IP overflow answers 429 with a generic body and sends nothing", async () => {
    const limitedIp = "203.0.113.41";
    const user = await seedUser(uniqueEmail("reset-ip-target"), true);
    sendEmailMock.mockClear();

    for (let i = 0; i < MAX_RESET_REQUESTS_PER_IP_PER_HOUR; i += 1) {
      const res = await postRequest({ email: uniqueEmail("reset-ip-filler") }, limitedIp);
      expect(res.status).toBe(200);
    }

    // The overflowing request targets an active account: the 429 must
    // short-circuit before any token or email work.
    const res = await postRequest({ email: user.email }, limitedIp);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(typeof body.error).toBe("string");
    expect(JSON.stringify(body)).not.toContain(user.email);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0);
  });

  it("per-IP overflow writes no bookkeeping rows, so 429s cannot drain the global quota", async () => {
    const limitedIp = "203.0.113.99";
    sendEmailMock.mockClear();

    for (let i = 0; i < MAX_RESET_REQUESTS_PER_IP_PER_HOUR; i += 1) {
      const res = await postRequest({ email: uniqueEmail("reset-ip-quota-filler") }, limitedIp);
      expect(res.status).toBe(200);
    }
    const rowsAtLimit = await prisma.securityRequest.count();

    // Once the IP is over its hourly quota, further attempts get 429 and add
    // no SecurityRequest rows — otherwise ~200 rejected requests from one IP
    // would exhaust MAX_RESET_REQUESTS_PER_DAY_GLOBAL for everyone.
    for (let i = 0; i < 3; i += 1) {
      const res = await postRequest({ email: uniqueEmail("reset-ip-quota-over") }, limitedIp);
      expect(res.status).toBe(429);
    }
    expect(await prisma.securityRequest.count()).toBe(rowsAtLimit);
  });
});

// ---------------------------------------------------------------------------
// Audit and failure handling
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/request — audit and failures", () => {
  it("writes an audit row holding neither the email nor the token", async () => {
    const user = await seedUser(uniqueEmail("reset-audit"), true);

    await postRequest({ email: user.email });
    const rawToken = tokenFromEmailText(sendEmailMock.mock.calls[0][0].text);

    const log = await prisma.log.findFirst({
      where: {
        action: "PASSWORD_RESET_REQUESTED",
        details: { contains: hashResetEmail(user.email) },
      },
    });
    expect(log).toBeTruthy();
    expect(log!.userId).toBeNull();
    expect(log!.details).not.toContain(user.email);
    expect(log!.details).not.toContain(rawToken);
  });

  it("audits unknown-email requests too, by hash only", async () => {
    const unknownEmail = uniqueEmail("reset-audit-unknown");

    await postRequest({ email: unknownEmail });

    const log = await prisma.log.findFirst({
      where: {
        action: "PASSWORD_RESET_REQUESTED",
        details: { contains: hashResetEmail(unknownEmail) },
      },
    });
    expect(log).toBeTruthy();
    expect(log!.details).not.toContain(unknownEmail);
  });

  it("a failing mail send never changes the response", async () => {
    const user = await seedUser(uniqueEmail("reset-mailfail"), true);
    const reference = await (await postRequest({ email: uniqueEmail("reset-ref4") })).json();
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("smtp unavailable"));

    const res = await postRequest({ email: user.email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(reference);

    // The token was still issued; the user can simply request again.
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
  });
});
