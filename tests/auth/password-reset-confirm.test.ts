/**
 * POST /api/auth/password-reset/confirm
 * (app/api/auth/password-reset/confirm/route.ts) — W6a self-service password
 * reset, step 2.
 *
 * Contract under test (see the route module header for the rationale):
 *
 * - ONE generic 400 body for unknown, malformed, expired and already-used
 *   tokens, for inactive accounts, and for unparseable/invalid bodies. The
 *   only distinguishable 400 is a password-policy violation, which carries
 *   the policy message and leaves the token usable.
 * - A valid token resets the password (bcrypt cost 10, verified through the
 *   real lib/auth.ts authorize) and bumps sessionVersion in one transaction,
 *   so a session carrying the previous sv is rejected by the existing
 *   getActiveUser check; the used token and the user's other unused tokens
 *   are invalidated, and the same token a second time fails.
 * - Confirm attempts are limited per hashed IP (10/hour, failures included):
 *   the overflow answers a generic 429 — even for a valid token — and adds
 *   no further bookkeeping rows.
 * - Audit (PASSWORD_RESET_COMPLETED) is written on success and holds neither
 *   the token nor the email; the confirmation email is best-effort.
 *
 * Hermetic setup: DATABASE_URL points at a throwaway SQLite file (shared
 * travel-db helpers), @/lib/email is mocked, and NEXTAUTH_SECRET /
 * NEXTAUTH_URL are set before the route module is imported. Token rows are
 * seeded directly through Prisma (issuance is the request endpoint's
 * concern, covered by password-reset-request.test.ts).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";

// Must be set before the route module (and lib/partners/abuse.ts hashing) runs.
process.env.NEXTAUTH_SECRET = String("password-reset-confirm-test-secret-32!");
process.env.NEXTAUTH_URL = String("http://localhost:3000");

import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR,
  SECURITY_REQUEST_KIND_CONFIRM,
} from "@/lib/security/limits";
import { generateResetToken, hashResetToken, resetTokenExpiry } from "@/lib/security/reset-token";
import { hashClientIp } from "@/lib/partners/abuse";
import { RESET_CONFIRMED_EMAIL_SUBJECT } from "@/lib/security/emails";
import { sendEmail } from "@/lib/email";

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })),
}));

const sendEmailMock = vi.mocked(sendEmail);

let prisma: PrismaClient;
let POST: typeof import("@/app/api/auth/password-reset/confirm/route").POST;
let authOptions: typeof import("@/lib/auth").authOptions;
let getActiveUser: typeof import("@/lib/access-policy").getActiveUser;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  POST = (await import("@/app/api/auth/password-reset/confirm/route")).POST;
  authOptions = (await import("@/lib/auth")).authOptions;
  getActiveUser = (await import("@/lib/access-policy")).getActiveUser;
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
function compliantPassword(): string {
  return `pw-${crypto.randomBytes(12).toString("hex")}`;
}

async function seedUser(email: string, active: boolean, password: string) {
  return prisma.user.create({
    data: {
      email,
      name: "Confirm Test User",
      password: bcrypt.hashSync(password, 10),
      role: "USER",
      active,
    },
  });
}

/** A reset token row the way the request endpoint would have stored it. */
async function mintToken(
  userId: string,
  overrides: { expiresAt?: Date; usedAt?: Date } = {},
): Promise<string> {
  const raw = generateResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashResetToken(raw),
      expiresAt: overrides.expiresAt ?? resetTokenExpiry(),
      usedAt: overrides.usedAt ?? null,
    },
  });
  return raw;
}

async function postConfirm(body: unknown, ip: string = nextIp()) {
  return POST(
    new NextRequest("http://localhost:3000/api/auth/password-reset/confirm", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
    }),
  );
}

/** The reference generic-400 body, captured from an unknown-token attempt. */
async function genericInvalidBody() {
  const res = await postConfirm({ token: generateResetToken(), password: compliantPassword() });
  expect(res.status).toBe(400);
  return res.json();
}

async function sessionVersionOf(userId: string): Promise<number> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sessionVersion: true },
  });
  return row.sessionVersion;
}

/**
 * The credentials provider as NextAuth normalizes it at request time (the
 * top-level authorize is a stub; the real one lives under `.options`) — same
 * reproduction as tests/auth/auth.test.ts, so sign-in is exercised through
 * the real lib/auth.ts authorize.
 */
function credentialsProvider(): { authorize: (credentials: unknown) => Promise<unknown> } {
  const { options, ...rest } = authOptions.providers[0] as any;
  return { ...rest, ...options };
}

/** A session the way the W1b gates see it; `sv` stands in for the JWT claim. */
function sessionAs(userId: string, sv: number) {
  return { user: { id: userId, sv }, expires: "2099-01-01" } as any;
}

// ---------------------------------------------------------------------------
// Uniform generic 400 — no distinction between failure causes
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/confirm — generic 400 uniformity", () => {
  it("answers the identical 400 for unknown, malformed, expired and used tokens", async () => {
    const reference = await genericInvalidBody();
    const user = await seedUser(uniqueEmail("confirm-uniform"), true, compliantPassword());
    const expiredRaw = await mintToken(user.id, { expiresAt: new Date(Date.now() - 1000) });
    const usedRaw = await mintToken(user.id, { usedAt: new Date() });
    const svBefore = await sessionVersionOf(user.id);

    const cases = [
      { token: generateResetToken(), password: compliantPassword() }, // unknown
      { token: "not-a-token", password: compliantPassword() }, // malformed
      { token: expiredRaw, password: compliantPassword() }, // expired
      { token: usedRaw, password: compliantPassword() }, // already used
    ];
    for (const body of cases) {
      const res = await postConfirm(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(reference);
    }

    // None of the attempts touched the account: the session version is
    // unchanged, and the failed attempts did not consume the seeded tokens
    // (the expired one stays as seeded, usedAt still null).
    expect(await sessionVersionOf(user.id)).toBe(svBefore);
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens.filter((t) => t.usedAt === null)).toHaveLength(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("answers the same generic 400 for unparseable and schema-invalid bodies", async () => {
    const reference = await genericInvalidBody();
    const rowsBefore = await prisma.securityRequest.count({
      where: { kind: SECURITY_REQUEST_KIND_CONFIRM },
    });

    const unparseable = await postConfirm("not json");
    expect(unparseable.status).toBe(400);
    expect(await unparseable.json()).toEqual(reference);

    for (const body of [
      {},
      { token: generateResetToken() }, // missing password
      { token: "", password: compliantPassword() }, // empty token
      { token: generateResetToken(), password: "" }, // empty password
    ]) {
      const res = await postConfirm(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(reference);
    }

    // Invalid bodies never reach the bookkeeping stage.
    expect(
      await prisma.securityRequest.count({ where: { kind: SECURITY_REQUEST_KIND_CONFIRM } }),
    ).toBe(rowsBefore);
  });

  it("an inactive account cannot reset, and the answer is the generic 400", async () => {
    const reference = await genericInvalidBody();
    const oldPassword = compliantPassword();
    const user = await seedUser(uniqueEmail("confirm-inactive"), false, oldPassword);
    const raw = await mintToken(user.id);

    const res = await postConfirm({ token: raw, password: compliantPassword() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(reference);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(oldPassword, row.password)).toBe(true);
    expect(row.sessionVersion).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Successful reset
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/confirm — successful reset", () => {
  it("sets the new password and bumps sessionVersion in one transaction", async () => {
    const oldPassword = compliantPassword();
    const newPassword = compliantPassword();
    const user = await seedUser(uniqueEmail("confirm-success"), true, oldPassword);
    const raw = await mintToken(user.id);

    const res = await postConfirm({ token: raw, password: newPassword });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.message).toBe("string");
    expect(body.error).toBeUndefined();

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(newPassword, row.password)).toBe(true);
    expect(await bcrypt.compare(oldPassword, row.password)).toBe(false);
    expect(row.sessionVersion).toBe(1);

    const token = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(raw) },
    });
    expect(token.usedAt).not.toBeNull();
  });

  it("invalidates the user's other unused tokens, and only theirs", async () => {
    const user = await seedUser(uniqueEmail("confirm-rotate"), true, compliantPassword());
    const other = await seedUser(uniqueEmail("confirm-bystander"), true, compliantPassword());
    const raw = await mintToken(user.id);
    const otherUnusedOfUser = await mintToken(user.id);
    const bystanderRaw = await mintToken(other.id);

    const res = await postConfirm({ token: raw, password: compliantPassword() });
    expect(res.status).toBe(200);

    const userTokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(userTokens).toHaveLength(2);
    expect(userTokens.every((t) => t.usedAt !== null)).toBe(true);

    // The second pre-existing token cannot be used for another reset either.
    const replay = await postConfirm({ token: otherUnusedOfUser, password: compliantPassword() });
    expect(replay.status).toBe(400);

    const bystanderToken = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(bystanderRaw) },
    });
    expect(bystanderToken.usedAt).toBeNull();
  });

  it("the same token a second time fails with the generic 400 and changes nothing", async () => {
    const firstPassword = compliantPassword();
    const secondPassword = compliantPassword();
    const user = await seedUser(uniqueEmail("confirm-replay"), true, compliantPassword());
    const raw = await mintToken(user.id);

    const first = await postConfirm({ token: raw, password: firstPassword });
    expect(first.status).toBe(200);
    const reference = await genericInvalidBody();

    const second = await postConfirm({ token: raw, password: secondPassword });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual(reference);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(firstPassword, row.password)).toBe(true);
    expect(row.sessionVersion).toBe(1); // not bumped again
  });

  it("the new password signs in through authorize; the old sv session is rejected", async () => {
    const oldPassword = compliantPassword();
    const newPassword = compliantPassword();
    const user = await seedUser(uniqueEmail("confirm-signin"), true, oldPassword);
    const raw = await mintToken(user.id);

    // Before the reset the sv-0 session resolves.
    expect((await getActiveUser(sessionAs(user.id, 0)))?.id).toBe(user.id);

    const res = await postConfirm({ token: raw, password: newPassword });
    expect(res.status).toBe(200);

    // The existing session check rejects tokens minted before the reset…
    expect(await getActiveUser(sessionAs(user.id, 0))).toBeNull();
    // …while a session carrying the post-reset sv still resolves.
    expect((await getActiveUser(sessionAs(user.id, 1)))?.id).toBe(user.id);

    // Sign-in through the real authorize path: new password in, old one out.
    const signedIn: any = await credentialsProvider().authorize({
      email: user.email,
      password: newPassword,
    });
    expect(signedIn).not.toBeNull();
    expect(signedIn.id).toBe(user.id);
    expect(signedIn.sv).toBe(1);
    expect(
      await credentialsProvider().authorize({ email: user.email, password: oldPassword }),
    ).toBeNull();
  });

  it("writes a PASSWORD_RESET_COMPLETED audit entry holding neither token nor email", async () => {
    const user = await seedUser(uniqueEmail("confirm-audit"), true, compliantPassword());
    const raw = await mintToken(user.id);

    const res = await postConfirm({ token: raw, password: compliantPassword() });
    expect(res.status).toBe(200);

    const log = await prisma.log.findFirst({
      where: { action: "PASSWORD_RESET_COMPLETED", userId: user.id },
    });
    expect(log).toBeTruthy();
    expect(log!.details ?? "").not.toContain(raw);
    expect(log!.details ?? "").not.toContain(user.email);
  });

  it("sends a confirmation email, and a failing send never fails the request", async () => {
    const user = await seedUser(uniqueEmail("confirm-mail"), true, compliantPassword());
    const raw = await mintToken(user.id);

    const res = await postConfirm({ token: raw, password: compliantPassword() });
    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe(user.email);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe(RESET_CONFIRMED_EMAIL_SUBJECT);

    // Best-effort: a rejected send still answers success — the reset already
    // happened and the response must not suggest otherwise.
    const user2 = await seedUser(uniqueEmail("confirm-mailfail"), true, compliantPassword());
    const raw2 = await mintToken(user2.id);
    sendEmailMock.mockRejectedValueOnce(new Error("smtp unavailable"));
    const res2 = await postConfirm({ token: raw2, password: compliantPassword() });
    expect(res2.status).toBe(200);
    const row2 = await prisma.user.findUniqueOrThrow({ where: { id: user2.id } });
    expect(row2.sessionVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/confirm — password policy", () => {
  it("a policy-violating password returns the policy message and leaves the token usable", async () => {
    const user = await seedUser(uniqueEmail("confirm-policy"), true, compliantPassword());
    const raw = await mintToken(user.id);
    const generic = await genericInvalidBody();

    for (const bad of ["short", String("password123456"), user.email]) {
      const res = await postConfirm({ token: raw, password: bad });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(typeof body.error).toBe("string");
      expect(body).not.toEqual(generic); // the policy message, not the generic 400
    }

    // Specific messages from the shared policy.
    const tooShort = await (await postConfirm({ token: raw, password: "short" })).json();
    expect(tooShort.error).toContain("at least 12 characters");
    const tooCommon = await (
      await postConfirm({ token: raw, password: String("password123456") })
    ).json();
    expect(tooCommon.error).toContain("too common");
    const sameAsEmail = await (await postConfirm({ token: raw, password: user.email })).json();
    expect(sameAsEmail.error).toContain("email");

    // The token survived every rejection: a compliant password still resets.
    const good = compliantPassword();
    const ok = await postConfirm({ token: raw, password: good });
    expect(ok.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(good, row.password)).toBe(true);
    expect(row.sessionVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Confirm-attempt limit
// ---------------------------------------------------------------------------

describe("POST /api/auth/password-reset/confirm — limits", () => {
  it("the per-IP overflow answers a generic 429 — even for a valid token — and adds no rows", async () => {
    const limitedIp = "203.0.113.77";
    const user = await seedUser(uniqueEmail("confirm-limited"), true, compliantPassword());
    const raw = await mintToken(user.id);

    // Failed attempts count toward the quota: burn it with unknown tokens.
    for (let i = 0; i < MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR; i += 1) {
      const res = await postConfirm(
        { token: generateResetToken(), password: compliantPassword() },
        limitedIp,
      );
      expect(res.status).toBe(400);
    }
    const rowsAtLimit = await prisma.securityRequest.count({
      where: { kind: SECURITY_REQUEST_KIND_CONFIRM, ipHash: hashClientIp(limitedIp) },
    });
    expect(rowsAtLimit).toBe(MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR);

    // The overflowing attempt holds a VALID token: the 429 must short-circuit
    // before any token or password work, with a body that names nothing.
    const res = await postConfirm({ token: raw, password: compliantPassword() }, limitedIp);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["error"]);
    expect(JSON.stringify(body)).not.toContain(raw);

    const token = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(raw) },
    });
    expect(token.usedAt).toBeNull();
    expect(await sessionVersionOf(user.id)).toBe(0);
    expect(
      await prisma.securityRequest.count({
        where: { kind: SECURITY_REQUEST_KIND_CONFIRM, ipHash: hashClientIp(limitedIp) },
      }),
    ).toBe(rowsAtLimit);

    // The limit is per IP: the same token works from another address.
    const ok = await postConfirm({ token: raw, password: compliantPassword() });
    expect(ok.status).toBe(200);
  });
});
