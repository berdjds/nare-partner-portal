/**
 * Session-revocation trigger tests (W1b, sv-revoke): proves that every
 * administrative action that must invalidate a user's issued sessions actually
 * bumps User.sessionVersion, and that the bump revokes stale tokens end to end
 * through lib/access-policy.ts getActiveUser:
 *
 *  - PATCH /api/users bumps on a password change, on a role change, and on
 *    deactivation (active: false) — but NOT on name/email/phone-only edits or
 *    no-op values.
 *  - POST /api/users/[id]/revoke-sessions lets an ADMIN revoke a target's
 *    sessions on demand, with a SESSIONS_REVOKED audit entry; anonymous gets
 *    401, non-admin 403 (and no bump), unknown id 404.
 *  - POST /api/auth/sign-out-everywhere lets any active user revoke their OWN
 *    sessions, with a SIGN_OUT_EVERYWHERE audit entry; anonymous gets 401.
 *
 * Sessions are mocked; routes run against the seeded throwaway DB (same
 * pattern as api-access.test.ts). Each test creates its own target user so
 * the bumps never leak between tests; the admin fixture's own sessionVersion
 * is never bumped, so its sv-less session stays valid throughout.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

let prisma: PrismaClient;
let usersPATCH: typeof import("@/app/api/users/route").PATCH;
let revokePOST: typeof import("@/app/api/users/[id]/revoke-sessions/route").POST;
let signOutEverywherePOST: typeof import("@/app/api/auth/sign-out-everywhere/route").POST;
let getActiveUser: typeof import("@/lib/access-policy").getActiveUser;

let admin: { id: string; email: string; name: string | null; role: string };
let plainUser: { id: string; email: string; name: string | null; role: string };
let advisor: { id: string; email: string; name: string | null; role: string };

/** Session the way NextAuth returns it; `sv` stands in for the session-version JWT claim (W1b). */
function login(
  u: { id: string; email: string; name: string | null; role: string } | null,
  roleOverride?: string,
  sv?: number,
) {
  sessionRef.current = u
    ? {
        user: { id: u.id, role: roleOverride ?? u.role, email: u.email, name: u.name, ...(sv !== undefined ? { sv } : {}) },
        expires: "2099-01-01",
      }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const USERS_URL = "http://localhost:3000/api/users";
const REVOKE_URL = (id: string) => `http://localhost:3000/api/users/${id}/revoke-sessions`;
const SIGN_OUT_URL = "http://localhost:3000/api/auth/sign-out-everywhere";

let targetSeq = 0;
/** Per-test target user: every test owns the bumps on its own row. */
function createTarget(role = "USER") {
  targetSeq += 1;
  return prisma.user.create({
    data: { email: `sv-target-${targetSeq}@test.io`, name: `Target ${targetSeq}`, password: "x", role },
  });
}

async function sessionVersionOf(id: string): Promise<number> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id }, select: { sessionVersion: true } });
  return row.sessionVersion;
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  usersPATCH = (await import("@/app/api/users/route")).PATCH;
  revokePOST = (await import("@/app/api/users/[id]/revoke-sessions/route")).POST;
  signOutEverywherePOST = (await import("@/app/api/auth/sign-out-everywhere/route")).POST;
  getActiveUser = (await import("@/lib/access-policy")).getActiveUser;

  // The admin's own sessionVersion is never bumped, so its sv-less session
  // (reads as 0) stays valid for every test in this file.
  admin = await prisma.user.create({ data: { email: "sv-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  plainUser = await prisma.user.create({ data: { email: "sv-user@test.io", name: "User", password: "x", role: "USER" } });
  advisor = await prisma.user.create({ data: { email: "sv-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" } });
});

beforeEach(() => {
  login(null);
});

describe("PATCH /api/users revocation triggers (W1b)", () => {
  it("password change bumps the session version (W1b)", async () => {
    const target = await createTarget();
    login(admin);
    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, password: "newpass123" } }));
    expect(res.status).toBe(200);

    expect(await sessionVersionOf(target.id)).toBe(1);

    // The bump is a real revocation: a session minted at sv 0 now resolves as
    // unauthenticated, while one carrying the current sv still resolves.
    expect(await getActiveUser({ user: { id: target.id, sv: 0 }, expires: "2099-01-01" } as any)).toBeNull();
    const current = await getActiveUser({ user: { id: target.id, sv: 1 }, expires: "2099-01-01" } as any);
    expect(current?.id).toBe(target.id);

    // The new password was actually stored (bcrypt hash verifies).
    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await bcrypt.compare("newpass123", row.password)).toBe(true);
  });

  it("role change bumps the session version (W1b)", async () => {
    const target = await createTarget("USER");
    login(admin);

    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, role: "ADVISOR" } }));
    expect(res.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);

    // A no-op PATCH carrying the role the user already has must NOT bump again.
    const noop = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, role: "ADVISOR" } }));
    expect(noop.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);
  });

  it("deactivation (active=false) bumps the session version (W1b)", async () => {
    const target = await createTarget();
    login(admin);
    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, active: false } }));
    expect(res.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);
  });

  it("PATCH with name-only change does NOT bump the session version", async () => {
    const target = await createTarget();
    login(admin);
    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, name: "Renamed Target" } }));
    expect(res.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(0);
    // A sv-0 session therefore keeps working after a profile-only edit.
    expect((await getActiveUser({ user: { id: target.id, sv: 0 }, expires: "2099-01-01" } as any))?.id).toBe(target.id);
  });
});

describe("POST /api/users/[id]/revoke-sessions (W1b)", () => {
  it("admin revoke-sessions bumps the target's session version and writes an audit entry (W1b)", async () => {
    const target = await createTarget();
    login(admin);
    const res = await revokePOST(req(REVOKE_URL(target.id), { method: "POST" }), {
      params: Promise.resolve({ id: target.id }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await sessionVersionOf(target.id)).toBe(1);
    // A token minted before the revocation is dead on the next request.
    expect(await getActiveUser({ user: { id: target.id, sv: 0 }, expires: "2099-01-01" } as any)).toBeNull();

    // The audit entry is attributed to the admin, not the target.
    const audit = await prisma.log.findFirst({ where: { action: "SESSIONS_REVOKED", userId: admin.id } });
    expect(audit).toBeTruthy();
  });

  it("rejects anonymous callers with 401", async () => {
    const target = await createTarget();
    login(null);
    const res = await revokePOST(req(REVOKE_URL(target.id), { method: "POST" }), {
      params: Promise.resolve({ id: target.id }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
    expect(await sessionVersionOf(target.id)).toBe(0);
  });

  it("rejects logged-in non-admins with 403 and never bumps or audits", async () => {
    for (const who of [plainUser, advisor]) {
      const target = await createTarget();
      login(who);
      const res = await revokePOST(req(REVOKE_URL(target.id), { method: "POST" }), {
        params: Promise.resolve({ id: target.id }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("Forbidden");
      expect(await sessionVersionOf(target.id)).toBe(0);
      expect(await prisma.log.count({ where: { action: "SESSIONS_REVOKED", userId: who.id } })).toBe(0);
    }
  });

  it("returns 404 for an unknown target id", async () => {
    login(admin);
    const res = await revokePOST(req(REVOKE_URL("no-such-user-id"), { method: "POST" }), {
      params: Promise.resolve({ id: "no-such-user-id" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("User not found");
  });
});

describe("POST /api/auth/sign-out-everywhere (W1b)", () => {
  it("self sign-out-everywhere bumps the caller's own session version (W1b)", async () => {
    const target = await createTarget();
    login(target, undefined, 0); // the caller's own session, minted at sv 0
    const res = await signOutEverywherePOST(req(SIGN_OUT_URL, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(await sessionVersionOf(target.id)).toBe(1);
    // The very session that made the call is now stale: sv 0 no longer resolves.
    expect(await getActiveUser({ user: { id: target.id, sv: 0 }, expires: "2099-01-01" } as any)).toBeNull();

    const audit = await prisma.log.findFirst({ where: { action: "SIGN_OUT_EVERYWHERE", userId: target.id } });
    expect(audit).toBeTruthy();
  });

  it("rejects anonymous callers with 401", async () => {
    login(null);
    const res = await signOutEverywherePOST(req(SIGN_OUT_URL, { method: "POST" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });
});
