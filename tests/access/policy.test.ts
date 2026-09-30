/**
 * Interim access policy unit tests (W1, msg-access): pins the role predicates
 * and the database-backed gates in lib/access-policy.ts. The current DB role
 * must win over whatever role the JWT/session claims — that is what makes a
 * deactivation or role change take effect on the next request.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

let prisma: PrismaClient;
let policy: typeof import("@/lib/access-policy");

let admin: { id: string; email: string; name: string | null; role: string };
let user: { id: string; email: string; name: string | null; role: string };
let advisor: { id: string; email: string; name: string | null; role: string };
let validator: { id: string; email: string; name: string | null; role: string };
let inactive: { id: string; email: string; name: string | null; role: string };

function sessionFor(
  u: { id: string; email: string; name: string | null; role: string } | null,
  roleOverride?: string,
  sv?: number,
) {
  if (!u) return null;
  return {
    user: { id: u.id, role: roleOverride ?? u.role, email: u.email, name: u.name, ...(sv !== undefined ? { sv } : {}) },
    expires: "2099-01-01",
  } as any;
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  policy = await import("@/lib/access-policy");

  admin = await prisma.user.create({ data: { email: "pol-admin@test.io", name: "Admin", password: "x", role: "ADMIN" } });
  user = await prisma.user.create({ data: { email: "pol-user@test.io", name: "User", password: "x", role: "USER" } });
  advisor = await prisma.user.create({ data: { email: "pol-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" } });
  validator = await prisma.user.create({ data: { email: "pol-validator@test.io", name: "Validator", password: "x", role: "VALIDATOR" } });
  inactive = await prisma.user.create({
    data: { email: "pol-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
  });
});

describe("canUseInbox", () => {
  it("is true for ADMIN and USER only", () => {
    expect(policy.canUseInbox("ADMIN")).toBe(true);
    expect(policy.canUseInbox("USER")).toBe(true);
    expect(policy.canUseInbox("ADVISOR")).toBe(false);
    expect(policy.canUseInbox("VALIDATOR")).toBe(false);
    expect(policy.canUseInbox("admin")).toBe(false); // exact match, not case-insensitive
    expect(policy.canUseInbox(null)).toBe(false);
    expect(policy.canUseInbox(undefined)).toBe(false);
    expect(policy.canUseInbox("")).toBe(false);
  });
});

describe("canAdministerWhatsApp", () => {
  it("is true for ADMIN only", () => {
    expect(policy.canAdministerWhatsApp("ADMIN")).toBe(true);
    expect(policy.canAdministerWhatsApp("USER")).toBe(false);
    expect(policy.canAdministerWhatsApp("ADVISOR")).toBe(false);
    expect(policy.canAdministerWhatsApp("VALIDATOR")).toBe(false);
    expect(policy.canAdministerWhatsApp(undefined)).toBe(false);
  });
});

describe("getActiveUser", () => {
  it("returns the CURRENT database role even when the session/JWT claims another", async () => {
    // The JWT said this user was ADMIN at login; the DB says USER. DB wins.
    const resolved = await policy.getActiveUser(sessionFor(user, "ADMIN"));
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(user.id);
    expect(resolved!.role).toBe("USER");
  });

  it("returns null without a session user id, for a deleted user, and for an inactive user", async () => {
    expect(await policy.getActiveUser(null)).toBeNull();
    expect(
      await policy.getActiveUser({ user: { id: "no-such-user", role: "ADMIN" }, expires: "2099-01-01" } as any),
    ).toBeNull();
    expect(await policy.getActiveUser(sessionFor(inactive))).toBeNull();
  });
});

describe("requireInboxAccess", () => {
  it("answers 401 without a session", async () => {
    const decision = await policy.requireInboxAccess(null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.response.status).toBe(401);
      expect((await decision.response.json()).error).toBe("Unauthorized");
    }
  });

  it("answers 401 for a deactivated user (a revoked credential, not a role denial)", async () => {
    const decision = await policy.requireInboxAccess(sessionFor(inactive));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.response.status).toBe(401);
  });

  it("answers 403 for active travel-only roles", async () => {
    for (const who of [advisor, validator]) {
      const decision = await policy.requireInboxAccess(sessionFor(who));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.response.status).toBe(403);
        expect((await decision.response.json()).error).toBe("Forbidden");
      }
    }
  });

  it("allows ADMIN and USER and hands back the database user", async () => {
    for (const who of [admin, user]) {
      const decision = await policy.requireInboxAccess(sessionFor(who));
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.user.id).toBe(who.id);
    }
  });
});

describe("requireWhatsAppAdminAccess", () => {
  it("allows only an active ADMIN; everyone else gets 401 (pre-W1 POST behavior)", async () => {
    const allowed = await policy.requireWhatsAppAdminAccess(sessionFor(admin));
    expect(allowed.allowed).toBe(true);

    for (const session of [null, sessionFor(user), sessionFor(advisor), sessionFor(validator), sessionFor(inactive)]) {
      const decision = await policy.requireWhatsAppAdminAccess(session);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.response.status).toBe(401);
    }
  });
});

describe("session version (W1b)", () => {
  // The session version is the User.sessionVersion column; the fixtures above
  // are created with the schema default, so they all sit at version 0.
  it("getActiveUserById without an expected version returns the user and exposes the current sessionVersion", async () => {
    const resolved = await policy.getActiveUserById(user.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(user.id);
    expect(resolved!.sessionVersion).toBe(0);
  });

  it("getActiveUserById matches only the expected version — 0 is a real version, not a bypass", async () => {
    expect((await policy.getActiveUserById(user.id, 0))?.id).toBe(user.id);
    expect(await policy.getActiveUserById(user.id, 1)).toBeNull();
  });

  it("getActiveUser treats a missing sv exactly like sv: 0", async () => {
    // The pre-W1b session shape carries no sv at all — counts as 0.
    expect(sessionFor(user).user).not.toHaveProperty("sv");
    expect((await policy.getActiveUser(sessionFor(user)))?.id).toBe(user.id);
    expect((await policy.getActiveUser(sessionFor(user, undefined, 0)))?.id).toBe(user.id);
    // An sv that does not match the current version is refused.
    expect(await policy.getActiveUser(sessionFor(user, undefined, 1))).toBeNull();
  });

  it("bumping the session version revokes sessions carrying the old sv — including legacy tokens with no sv claim", async () => {
    // Dedicated user: the shared fixtures above are reused by other suites.
    const bumped = await prisma.user.create({
      data: { email: "pol-bumped@test.io", name: "Bumped", password: "x", role: "USER" },
    });
    expect((await policy.getActiveUser(sessionFor(bumped, undefined, 0)))?.id).toBe(bumped.id);

    await policy.revokeAllSessions(bumped.id);

    expect(await policy.getActiveUser(sessionFor(bumped, undefined, 0))).toBeNull();
    expect((await policy.getActiveUser(sessionFor(bumped, undefined, 1)))?.id).toBe(bumped.id);
    // Pre-W1b tokens carry no sv claim; they equal 0, which no longer matches
    // after the bump — a legacy token is revoked like any other stale token.
    expect(await policy.getActiveUser(sessionFor(bumped))).toBeNull();
  });

  it("requireInboxAccess with a stale sv answers 401 (revocation is indistinguishable from no session)", async () => {
    const stale = await prisma.user.create({
      data: { email: "pol-stale@test.io", name: "Stale", password: "x", role: "USER" },
    });
    await policy.revokeAllSessions(stale.id);

    const decision = await policy.requireInboxAccess(sessionFor(stale, undefined, 0));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.response.status).toBe(401);
      expect((await decision.response.json()).error).toBe("Unauthorized");
    }

    const current = await policy.requireInboxAccess(sessionFor(stale, undefined, 1));
    expect(current.allowed).toBe(true);
    if (current.allowed) expect(current.user.id).toBe(stale.id);
  });
});
