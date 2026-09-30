/**
 * W2 permission model tests (perm-core): pins the permission key set, the
 * role presets (which must reproduce the interim W1 role behaviour, with the
 * internal-cost keys admin-only per D2), grant/deny override precedence, and
 * the server helpers — getActiveUser must resolve effective permissions from
 * the current database row (role preset + UserPermission overrides) while a
 * stale session version still resolves as unauthenticated.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  INTERNAL_PERMISSION_KEYS,
  PERMISSION_KEYS,
  ROLE_PRESETS,
  effectivePermissions,
  hasPermission,
  isPermissionKey,
  presetForRole,
  type PermissionKey,
} from "@/lib/permissions";

let prisma: PrismaClient;
let policy: typeof import("@/lib/access-policy");

function sessionFor(u: { id: string; role: string; email: string; name: string | null }, sv?: number) {
  return {
    user: { id: u.id, role: u.role, email: u.email, name: u.name, ...(sv !== undefined ? { sv } : {}) },
    expires: "2099-01-01",
  } as any;
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  policy = await import("@/lib/access-policy");
});

const ALL_ROLES = ["ADMIN", "USER", "ADVISOR", "VALIDATOR"] as const;

const EXPECTED_KEYS: PermissionKey[] = [
  "admin.users",
  "admin.settings",
  "whatsapp.inbox.view",
  "whatsapp.inbox.send",
  "whatsapp.admin",
  "travel.access",
  "travel.create",
  "travel.review",
  "travel.issue",
  "travel.client_docs.download",
  "travel.client_docs.send",
  "travel.internal.view",
  "travel.internal.download",
];

describe("permission keys", () => {
  it("is exactly the approved key list, unique and non-empty", () => {
    expect(Array.from(PERMISSION_KEYS)).toEqual(EXPECTED_KEYS);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it("isPermissionKey recognizes exactly the known keys", () => {
    for (const key of PERMISSION_KEYS) expect(isPermissionKey(key)).toBe(true);
    expect(isPermissionKey("inbox.use")).toBe(false);
    expect(isPermissionKey("TRAVEL.ACCESS")).toBe(false);
    expect(isPermissionKey("travel.internal")).toBe(false);
    expect(isPermissionKey("")).toBe(false);
    expect(isPermissionKey(null)).toBe(false);
    expect(isPermissionKey(42)).toBe(false);
  });

  it("the internal-cost keys are exactly travel.internal.view/download", () => {
    expect(Array.from(INTERNAL_PERMISSION_KEYS).sort()).toEqual([
      "travel.internal.download",
      "travel.internal.view",
    ]);
    for (const key of Array.from(INTERNAL_PERMISSION_KEYS)) expect(isPermissionKey(key)).toBe(true);
  });
});

describe("role presets", () => {
  it("ADMIN has every key", () => {
    expect(ROLE_PRESETS.ADMIN.size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) expect(ROLE_PRESETS.ADMIN.has(key)).toBe(true);
  });

  it("internal-cost keys are in the ADMIN preset only (D2)", () => {
    for (const role of ALL_ROLES) {
      for (const key of Array.from(INTERNAL_PERMISSION_KEYS)) {
        expect(ROLE_PRESETS[role].has(key), `${role} must not preset ${key}`).toBe(role === "ADMIN");
      }
    }
  });

  it("USER reproduces the current behaviour: inbox view/send, nothing else", () => {
    expect(Array.from(ROLE_PRESETS.USER).sort()).toEqual([
      "whatsapp.inbox.send",
      "whatsapp.inbox.view",
    ]);
  });

  it("ADVISOR reproduces the current behaviour: travel access, create, issue and client documents", () => {
    expect(Array.from(ROLE_PRESETS.ADVISOR).sort()).toEqual([
      "travel.access",
      "travel.client_docs.download",
      "travel.client_docs.send",
      "travel.create",
      "travel.issue",
    ]);
  });

  it("VALIDATOR reproduces the current behaviour: travel access, review and client documents", () => {
    expect(Array.from(ROLE_PRESETS.VALIDATOR).sort()).toEqual([
      "travel.access",
      "travel.client_docs.download",
      "travel.client_docs.send",
      "travel.review",
    ]);
  });

  it("the presets agree with the interim role predicates on the modeled gates", () => {
    for (const role of ALL_ROLES) {
      expect(presetForRole(role).has("whatsapp.inbox.view"), `inbox view for ${role}`).toBe(
        policy.canUseInbox(role),
      );
      expect(presetForRole(role).has("whatsapp.inbox.send"), `inbox send for ${role}`).toBe(
        policy.canUseInbox(role),
      );
      expect(presetForRole(role).has("whatsapp.admin"), `whatsapp.admin for ${role}`).toBe(
        policy.canAdministerWhatsApp(role),
      );
    }
  });

  it("administration keys (admin.users, admin.settings, whatsapp.admin) are ADMIN-only", () => {
    for (const key of ["admin.users", "admin.settings", "whatsapp.admin"] as const) {
      for (const role of ALL_ROLES) {
        expect(ROLE_PRESETS[role].has(key), `${role} must not preset ${key}`).toBe(role === "ADMIN");
      }
    }
  });

  it("unknown, empty and missing roles get the empty preset (exact match, not case-insensitive)", () => {
    for (const role of ["admin", "Admin", "", "SUPERUSER", null, undefined]) {
      expect(presetForRole(role).size).toBe(0);
    }
  });
});

describe("grant/deny overrides and precedence", () => {
  it("without overrides the effective set equals the role preset", () => {
    for (const role of ALL_ROLES) {
      const effective = effectivePermissions(role);
      expect(Array.from(effective).sort()).toEqual(Array.from(presetForRole(role)).sort());
    }
  });

  it("a grant adds a key the preset lacks (per-user inbox access, the W2 goal)", () => {
    const effective = effectivePermissions("ADVISOR", [{ key: "whatsapp.inbox.view", allowed: true }]);
    expect(effective.has("whatsapp.inbox.view")).toBe(true);
    expect(effective.has("travel.access")).toBe(true); // preset preserved
  });

  it("a deny removes a key the preset grants", () => {
    const effective = effectivePermissions("USER", [{ key: "whatsapp.inbox.send", allowed: false }]);
    expect(effective.has("whatsapp.inbox.send")).toBe(false);
    expect(effective.has("whatsapp.inbox.view")).toBe(true);
  });

  it("deny beats grant: a key granted and denied is not effective", () => {
    const effective = effectivePermissions("ADVISOR", [
      { key: "travel.review", allowed: true },
      { key: "travel.review", allowed: false },
    ]);
    expect(effective.has("travel.review")).toBe(false);
  });

  it("deny beats preset even for ADMIN (an admin can be restricted per key)", () => {
    const effective = effectivePermissions("ADMIN", [{ key: "travel.internal.view", allowed: false }]);
    expect(effective.has("travel.internal.view")).toBe(false);
    expect(effective.size).toBe(PERMISSION_KEYS.length - 1);
  });

  it("overrides with unknown keys are ignored", () => {
    const effective = effectivePermissions("ADVISOR", [
      { key: "travel.admin", allowed: true },
      { key: "bogus.key", allowed: false },
    ]);
    // Neither key exists, so only the preset survives.
    expect(Array.from(effective).sort()).toEqual(Array.from(presetForRole("ADVISOR")).sort());
  });

  it("never mutates the shared presets", () => {
    const before = new Set(presetForRole("USER"));
    effectivePermissions("USER", [
      { key: "admin.users", allowed: true },
      { key: "whatsapp.inbox.send", allowed: false },
    ]);
    expect(presetForRole("USER")).toEqual(before);
  });
});

describe("hasPermission", () => {
  it("checks the carried permission set and tolerates missing users", () => {
    const user = { permissions: effectivePermissions("USER") };
    expect(hasPermission(user, "whatsapp.inbox.view")).toBe(true);
    expect(hasPermission(user, "admin.users")).toBe(false);
    expect(hasPermission(null, "whatsapp.inbox.view")).toBe(false);
    expect(hasPermission(undefined, "whatsapp.inbox.view")).toBe(false);
  });
});

// --- Server helpers (database-backed) --------------------------------------

describe("getActiveUser permissions", () => {
  it("returns the role preset as effective permissions for a user without overrides", async () => {
    const plain = await prisma.user.create({
      data: { email: "perm-plain@test.io", name: "Plain", password: "x", role: "USER" },
    });
    const resolved = await policy.getActiveUser(sessionFor(plain));
    expect(resolved).not.toBeNull();
    expect(Array.from(resolved!.permissions).sort()).toEqual([
      "whatsapp.inbox.send",
      "whatsapp.inbox.view",
    ]);
    expect(hasPermission(resolved, "whatsapp.inbox.view")).toBe(true);
    expect(hasPermission(resolved, "travel.access")).toBe(false);
  });

  it("applies stored grant and deny overrides from the UserPermission rows", async () => {
    const overridden = await prisma.user.create({
      data: {
        email: "perm-override@test.io",
        name: "Override",
        password: "x",
        role: "ADVISOR",
        permissions: {
          create: [
            { key: "whatsapp.inbox.view", allowed: true },
            { key: "travel.create", allowed: false },
          ],
        },
      },
    });
    const resolved = await policy.getActiveUser(sessionFor(overridden));
    expect(resolved).not.toBeNull();
    // Granted on top of the ADVISOR preset, denied out of it.
    expect(hasPermission(resolved, "whatsapp.inbox.view")).toBe(true);
    expect(hasPermission(resolved, "travel.create")).toBe(false);
    expect(hasPermission(resolved, "travel.access")).toBe(true);
    expect(hasPermission(resolved, "travel.internal.view")).toBe(false);

    // Overrides follow the CURRENT rows: editing them takes effect on the next
    // read, like a role change.
    await prisma.userPermission.deleteMany({ where: { userId: overridden.id } });
    const after = await policy.getActiveUser(sessionFor(overridden));
    expect(hasPermission(after, "whatsapp.inbox.view")).toBe(false);
    expect(hasPermission(after, "travel.create")).toBe(true);
  });

  it("ignores override rows with unknown keys", async () => {
    const junk = await prisma.user.create({
      data: {
        email: "perm-junk@test.io",
        name: "Junk",
        password: "x",
        role: "ADVISOR",
        permissions: {
          create: [
            { key: "whatsapp.inbox.view", allowed: true },
            { key: "not.a.key", allowed: true },
          ],
        },
      },
    });
    const resolved = await policy.getActiveUser(sessionFor(junk));
    expect(resolved).not.toBeNull();
    expect(hasPermission(resolved, "whatsapp.inbox.view")).toBe(true);
    expect(resolved!.permissions.has("not.a.key" as PermissionKey)).toBe(false);
  });

  it("a stale sessionVersion still yields null, permissions notwithstanding", async () => {
    const stale = await prisma.user.create({
      data: {
        email: "perm-stale@test.io",
        name: "Stale",
        password: "x",
        role: "ADMIN",
        permissions: { create: [{ key: "admin.users", allowed: false }] },
      },
    });
    expect((await policy.getActiveUser(sessionFor(stale, 0)))?.permissions.has("admin.users")).toBe(false);

    await policy.revokeAllSessions(stale.id);

    expect(await policy.getActiveUser(sessionFor(stale, 0))).toBeNull();
    expect(await policy.getActiveUserById(stale.id, 0)).toBeNull();
    // The current version resolves again — with the permissions attached.
    const current = await policy.getActiveUser(sessionFor(stale, 1));
    expect(current).not.toBeNull();
    expect(hasPermission(current, "travel.internal.download")).toBe(true);
  });

  it("deactivated and deleted users yield null", async () => {
    const inactive = await prisma.user.create({
      data: { email: "perm-inactive@test.io", name: "Inactive", password: "x", role: "USER", active: false },
    });
    expect(await policy.getActiveUser(sessionFor(inactive))).toBeNull();
    expect(await policy.getActiveUserById("perm-no-such-id")).toBeNull();
  });
});

describe("requirePermission", () => {
  it("answers 401 without a session and 403 when the effective set lacks the key", async () => {
    const noSession = await policy.requirePermission(null, "whatsapp.inbox.view");
    expect(noSession.allowed).toBe(false);
    if (!noSession.allowed) expect(noSession.response.status).toBe(401);

    const advisor = await prisma.user.create({
      data: { email: "perm-req-advisor@test.io", name: "Advisor", password: "x", role: "ADVISOR" },
    });
    const lacking = await policy.requirePermission(sessionFor(advisor), "whatsapp.inbox.view");
    expect(lacking.allowed).toBe(false);
    if (!lacking.allowed) {
      expect(lacking.response.status).toBe(403);
      expect((await lacking.response.json()).error).toBe("Forbidden");
    }
  });

  it("allows via the role preset and via a per-user grant", async () => {
    const user = await prisma.user.create({
      data: { email: "perm-req-user@test.io", name: "User", password: "x", role: "USER" },
    });
    const viaPreset = await policy.requirePermission(sessionFor(user), "whatsapp.inbox.view");
    expect(viaPreset.allowed).toBe(true);
    if (viaPreset.allowed) expect(viaPreset.user.id).toBe(user.id);

    const granted = await prisma.user.create({
      data: {
        email: "perm-req-grant@test.io",
        name: "Granted",
        password: "x",
        role: "ADVISOR",
        permissions: { create: [{ key: "whatsapp.inbox.view", allowed: true }] },
      },
    });
    const viaGrant = await policy.requirePermission(sessionFor(granted), "whatsapp.inbox.view");
    expect(viaGrant.allowed).toBe(true);

    // ... but not when a deny overrides the preset.
    const deniedUser = await prisma.user.create({
      data: {
        email: "perm-req-deny@test.io",
        name: "Denied",
        password: "x",
        role: "USER",
        permissions: { create: [{ key: "whatsapp.inbox.view", allowed: false }] },
      },
    });
    const viaDeny = await policy.requirePermission(sessionFor(deniedUser), "whatsapp.inbox.view");
    expect(viaDeny.allowed).toBe(false);
    if (!viaDeny.allowed) expect(viaDeny.response.status).toBe(403);
  });
});
