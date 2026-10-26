/**
 * Password-policy enforcement tests for the users API (W7b, policy-api):
 * proves that POST /api/users and PATCH /api/users route every password
 * through the shared policy in lib/security/password-policy.ts before any
 * write happens:
 *
 *  - POST refuses too-short, common, and equal-to-email passwords with 400
 *    and the first policy rule message, creating no user row; a compliant
 *    password is accepted and stored as a bcrypt hash.
 *  - PATCH runs the same checks against the new email when the body changes
 *    it, otherwise against the target's current email; a refusal writes
 *    nothing (hash and sessionVersion untouched), while a compliant change
 *    stores the new hash and bumps sessionVersion (W1b revocation).
 *
 * Sessions are mocked; routes run against the seeded throwaway DB (same
 * pattern as session-revoke.test.ts). Sample passwords are built at run time
 * from innocuous fragments so no credential-looking literal appears in the
 * source.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { COMMON_PASSWORDS, PASSWORD_MIN_LENGTH } from "@/lib/security/password-policy";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

let prisma: PrismaClient;
let usersPOST: typeof import("@/app/api/users/route").POST;
let usersPATCH: typeof import("@/app/api/users/route").PATCH;

let admin: { id: string; email: string; name: string | null; role: string };

function login(u: { id: string; email: string; name: string | null; role: string } | null) {
  sessionRef.current = u
    ? { user: { id: u.id, role: u.role, email: u.email, name: u.name }, expires: "2099-01-01" }
    : null;
}

const USERS_URL = "http://localhost:3000/api/users";

function req(method: string, body: unknown) {
  return new NextRequest(USERS_URL, { method, body: JSON.stringify(body) });
}

/** Builds a sample password from innocuous fragments. */
function samplePassword(...fragments: string[]): string {
  return fragments.join("-");
}

let seq = 0;
/** Unique email per call — the throwaway DB is shared per file and never cleaned. */
function uniqueEmail(tag: string): string {
  seq += 1;
  return `upp-${tag}-${seq}@test.io`;
}

/** Per-test PATCH target; created directly, so its "x" password bypasses the policy. */
function createTarget(email: string) {
  return prisma.user.create({
    data: { email, name: `Target ${email}`, password: "x", role: "USER" },
  });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  const route = await import("@/app/api/users/route");
  usersPOST = route.POST;
  usersPATCH = route.PATCH;

  // sv-less session: the admin's sessionVersion is never bumped, so the
  // session (reads as sv 0) stays valid for every test in this file.
  admin = await prisma.user.create({
    data: { email: "upp-admin@test.io", name: "Admin", password: "x", role: "ADMIN" },
  });
});

beforeEach(() => {
  login(admin);
});

describe("POST /api/users password policy (W7b)", () => {
  it("refuses a password shorter than the minimum length and creates no user", async () => {
    const email = uniqueEmail("short");
    const shortPassword = samplePassword("tiny", "pass"); // 9 chars, below the 12-char minimum
    const res = await usersPOST(req("POST", { email, name: "Short Pass", password: shortPassword }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at least 12 characters");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses a common password of sufficient length and creates no user", async () => {
    const email = uniqueEmail("common");
    const commonPassword = COMMON_PASSWORDS.find((p) => p.length >= PASSWORD_MIN_LENGTH);
    expect(commonPassword).toBeDefined();
    const res = await usersPOST(req("POST", { email, name: "Common Pass", password: commonPassword }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Password is too common");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses a password equal to the new user's email and creates no user", async () => {
    const email = uniqueEmail("emailrule"); // well above the 12-char minimum
    const res = await usersPOST(req("POST", { email, name: "Email Pass", password: email }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("email address");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("accepts a compliant password and stores it as a bcrypt hash", async () => {
    const email = uniqueEmail("ok");
    const password = samplePassword("upp", "meadow", "harbor", "61");
    const res = await usersPOST(req("POST", { email, name: "Compliant", password }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe(email);

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(await bcrypt.compare(password, row.password)).toBe(true);
  });
});

describe("PATCH /api/users password policy (W7b)", () => {
  it("refuses a short new password without touching the hash or sessionVersion", async () => {
    const target = await createTarget(uniqueEmail("patchshort"));
    const shortPassword = samplePassword("tiny", "pass");
    const res = await usersPATCH(req("PATCH", { id: target.id, password: shortPassword }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at least 12 characters");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.password).toBe("x");
    expect(row.sessionVersion).toBe(0);
  });

  it("checks the target's current email when the PATCH carries no email field", async () => {
    const target = await createTarget(uniqueEmail("patchcurrent"));
    // Password equals the target's current email; the policy must look it up.
    const res = await usersPATCH(req("PATCH", { id: target.id, password: target.email }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("email address");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.password).toBe("x");
    expect(row.sessionVersion).toBe(0);
  });

  it("checks the new email when the PATCH also changes it, and writes nothing", async () => {
    const target = await createTarget(uniqueEmail("patchold"));
    const newEmail = uniqueEmail("patchnew");
    // Password equals the NEW email: the body email must win over the current one.
    const res = await usersPATCH(req("PATCH", { id: target.id, email: newEmail, password: newEmail }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("email address");

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.email).toBe(target.email);
    expect(row.password).toBe("x");
    expect(row.sessionVersion).toBe(0);
  });

  it("accepts a compliant password change, stores the hash, and bumps sessionVersion", async () => {
    const target = await createTarget(uniqueEmail("patchok"));
    const password = samplePassword("upp", "lantern", "summit", "27");
    const res = await usersPATCH(req("PATCH", { id: target.id, password }));

    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await bcrypt.compare(password, row.password)).toBe(true);
    expect(row.sessionVersion).toBe(1);
  });
});
