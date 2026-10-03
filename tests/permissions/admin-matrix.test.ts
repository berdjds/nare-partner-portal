/**
 * W2 (perm-admin): admin permission matrix API tests.
 *
 * Covers the admin-facing permission management surface:
 *
 * - GET/PUT /api/permissions (the matrix): 401 anonymous, 403 for active users
 *   lacking admin.users, 200 for admins and for non-admins holding an
 *   admin.users grant. PUT validates the target (404 unknown user, 400 unknown
 *   key, 400 self-change), applies overrides (allowed=true/false/null, where
 *   null resets to the role preset by deleting the UserPermission row), bumps
 *   the target's sessionVersion and writes a PERMISSIONS_UPDATED audit entry —
 *   and does neither when the overrides change nothing.
 * - GET/POST /api/permissions/report: the proposed-permissions migration
 *   report lists every existing user with preset-derived keys; POST confirms
 *   the migration exactly once (second call 409, single
 *   PERMISSIONS_MIGRATION_CONFIRMED Log row).
 * - Internal-cost lock (D2/D3): granting travel.internal.* to ANY user —
 *   ADMIN-role targets included — is 403 while the migration is unconfirmed
 *   (an orphan grant row would survive a demotion), and allowed for everyone
 *   after confirmation. The matching demote guard: PATCH /api/users refuses a
 *   role change away from ADMIN with 400 while unconfirmed when the user
 *   holds an internal-cost grant row, and allows it after removing the row or
 *   after confirmation.
 * - Last-administrator protection across PATCH/DELETE /api/users and the
 *   permissions PUT (no demote/deactivate/delete/permission-strip of the only
 *   active ADMIN-role user), plus the self-role / self-deactivation guards.
 * - Regression pins on the edited users routes (plain USER still gets 401,
 *   unknown-id DELETE 404, self-delete 400) and the now permission-keyed
 *   revoke-sessions gate.
 *
 * ORDERING MATTERS: Vitest runs tests in a file in declaration order, and the
 * migration confirmation is a global, permanent Log row — every test that
 * relies on the unconfirmed state (internal-cost lock, report confirmed=false,
 * internalLocked=true) is declared BEFORE the "migration report confirmation"
 * describe. Last-administrator tests temporarily deactivate every OTHER
 * active ADMIN (including the fixture admin) via withSoleActiveAdmin() and
 * restore them in a finally, so they are safe regardless of how many admins
 * earlier describes created.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { PERMISSION_KEYS } from "@/lib/permissions";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

let prisma: PrismaClient;
let matrixGET: typeof import("@/app/api/permissions/route").GET;
let matrixPUT: typeof import("@/app/api/permissions/route").PUT;
let reportGET: typeof import("@/app/api/permissions/report/route").GET;
let reportPOST: typeof import("@/app/api/permissions/report/route").POST;
let usersPATCH: typeof import("@/app/api/users/route").PATCH;
let usersDELETE: typeof import("@/app/api/users/route").DELETE;
let revokePOST: typeof import("@/app/api/users/[id]/revoke-sessions/route").POST;

type UserRow = { id: string; email: string; name: string | null; role: string };

let admin: UserRow;
let plainUser: UserRow;
let advisor: UserRow;
let validator: UserRow;
/** USER role holding an admin.users grant — passes the gate without being an ADMIN. */
let grantedUser: UserRow;

function login(u: UserRow | null) {
  sessionRef.current = u
    ? { user: { id: u.id, email: u.email, name: u.name, role: u.role }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const MATRIX_URL = "http://localhost:3000/api/permissions";
const REPORT_URL = "http://localhost:3000/api/permissions/report";
const USERS_URL = "http://localhost:3000/api/users";
const REVOKE_URL = (id: string) => `http://localhost:3000/api/users/${id}/revoke-sessions`;

const putOverrides = (userId: string, overrides: { key: string; allowed: boolean | null }[]) =>
  matrixPUT(req(MATRIX_URL, { method: "PUT", body: { userId, overrides } }));

let seq = 0;
/** Dedicated user row per case — the DB is shared per file and never cleaned. */
function createUser(role: string, tag: string, extra: { password?: string; active?: boolean } = {}) {
  seq += 1;
  return prisma.user.create({
    data: {
      email: `am-${tag}-${seq}@test.io`,
      name: `AM ${tag} ${seq}`,
      password: extra.password ?? "x",
      role,
      ...(extra.active !== undefined ? { active: extra.active } : {}),
    },
  });
}

async function sessionVersionOf(id: string): Promise<number> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id }, select: { sessionVersion: true } });
  return row.sessionVersion;
}

function permAuditRows(detailsContaining: string) {
  return prisma.log.findMany({ where: { action: "PERMISSIONS_UPDATED", details: { contains: detailsContaining } } });
}

const sorted = (xs: string[]) => [...xs].sort();

/**
 * Runs fn with `soleId` as the ONLY active ADMIN-role user in the database
 * (every other active admin — the fixture admin included — is deactivated for
 * the duration) and restores them afterwards, even when fn throws.
 */
async function withSoleActiveAdmin<T>(soleId: string, fn: () => Promise<T>): Promise<T> {
  const others = await prisma.user.findMany({
    where: { role: "ADMIN", active: true, id: { not: soleId } },
    select: { id: true },
  });
  const ids = others.map((o) => o.id);
  await prisma.user.updateMany({ where: { id: { in: ids } }, data: { active: false } });
  try {
    return await fn();
  } finally {
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { active: true } });
  }
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  matrixGET = (await import("@/app/api/permissions/route")).GET;
  matrixPUT = (await import("@/app/api/permissions/route")).PUT;
  reportGET = (await import("@/app/api/permissions/report/route")).GET;
  reportPOST = (await import("@/app/api/permissions/report/route")).POST;
  usersPATCH = (await import("@/app/api/users/route")).PATCH;
  usersDELETE = (await import("@/app/api/users/route")).DELETE;
  revokePOST = (await import("@/app/api/users/[id]/revoke-sessions/route")).POST;

  admin = await createUser("ADMIN", "admin");
  plainUser = await createUser("USER", "user");
  advisor = await createUser("ADVISOR", "advisor");
  validator = await createUser("VALIDATOR", "validator");
  grantedUser = await createUser("USER", "granted");
  await prisma.userPermission.create({ data: { userId: grantedUser.id, key: "admin.users", allowed: true } });
});

beforeEach(() => {
  login(null);
});

describe("permission API gate (admin.users)", () => {
  it("rejects anonymous callers with 401", async () => {
    login(null);
    expect((await matrixGET()).status).toBe(401);
    expect((await putOverrides(plainUser.id, [{ key: "whatsapp.inbox.view", allowed: true }])).status).toBe(401);
    expect((await reportGET()).status).toBe(401);
    expect((await reportPOST()).status).toBe(401);
  });

  it("rejects users without admin.users with 403", async () => {
    for (const who of [plainUser, advisor, validator]) {
      login(who);
      expect((await matrixGET()).status).toBe(403);
      expect((await putOverrides(plainUser.id, [{ key: "whatsapp.inbox.view", allowed: true }])).status).toBe(403);
      expect((await reportGET()).status).toBe(403);
      expect((await reportPOST()).status).toBe(403);
    }
  });

  it("allows an admin", async () => {
    login(admin);
    const res = await matrixGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.keys).toHaveLength(16);
    expect(new Set(body.keys)).toEqual(new Set(PERMISSION_KEYS));
    // The migration is unconfirmed at this point in the file (see ordering note).
    expect(body.internalLocked).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);

    expect((await reportGET()).status).toBe(200);
  });

  it("allows a non-admin granted admin.users", async () => {
    login(grantedUser);
    const res = await matrixGET();
    expect(res.status).toBe(200);
    expect((await res.json()).users.some((u: any) => u.id === grantedUser.id)).toBe(true);
    expect((await reportGET()).status).toBe(200);
  });
});

describe("GET /api/permissions matrix content", () => {
  it("reflects a deny override in overrides and effective", async () => {
    const denied = await createUser("USER", "denied");
    await prisma.userPermission.create({ data: { userId: denied.id, key: "whatsapp.inbox.send", allowed: false } });

    login(admin);
    const res = await matrixGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const entry = body.users.find((u: any) => u.id === denied.id);
    expect(entry).toBeTruthy();
    expect(entry.email).toBe(denied.email);
    expect(entry.role).toBe("USER");
    expect(entry.active).toBe(true);
    expect(entry.overrides).toContainEqual({ key: "whatsapp.inbox.send", allowed: false });
    // The deny wins over the USER preset: send drops out of effective, view stays.
    expect(entry.preset).toContain("whatsapp.inbox.send");
    expect(entry.effective).not.toContain("whatsapp.inbox.send");
    expect(entry.effective).toContain("whatsapp.inbox.view");
  });
});

describe("PUT /api/permissions validation", () => {
  it("rejects changing your own permissions", async () => {
    login(admin);
    const before = await sessionVersionOf(admin.id);
    const res = await putOverrides(admin.id, [{ key: "whatsapp.inbox.send", allowed: false }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot change your own permissions");

    // No state changed and no audit entry was written.
    expect(await sessionVersionOf(admin.id)).toBe(before);
    expect(await prisma.userPermission.count({ where: { userId: admin.id } })).toBe(0);
    expect(
      await prisma.log.count({
        where: { action: "PERMISSIONS_UPDATED", userId: admin.id, details: { contains: admin.email } },
      }),
    ).toBe(0);
  });

  it("rejects an unknown user with 404", async () => {
    login(admin);
    const res = await putOverrides("am-no-such-user", [{ key: "whatsapp.inbox.view", allowed: true }]);
    expect(res.status).toBe(404);
  });

  it("rejects unknown permission keys with 400", async () => {
    const target = await createUser("USER", "badkey");
    login(admin);
    const res = await putOverrides(target.id, [{ key: "not.a.permission", allowed: true }]);
    expect(res.status).toBe(400);
    expect(await prisma.userPermission.count({ where: { userId: target.id } })).toBe(0);
    expect(await sessionVersionOf(target.id)).toBe(0);
  });
});

describe("self role/deactivation guards (PATCH /api/users)", () => {
  it("rejects self role escalation", async () => {
    login(admin);
    const own = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: admin.id, role: "USER" } }));
    expect(own.status).toBe(400);
    expect((await own.json()).error).toBe("Cannot change your own role");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role).toBe("ADMIN");

    // The guard is caller-id based, not role based: a USER holding admin.users
    // must not promote themselves to ADMIN through the users API either.
    login(grantedUser);
    const esc = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: grantedUser.id, role: "ADMIN" } }));
    expect(esc.status).toBe(400);
    expect((await esc.json()).error).toBe("Cannot change your own role");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: grantedUser.id } })).role).toBe("USER");
  });

  it("rejects deactivating yourself", async () => {
    login(admin);
    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: admin.id, active: false } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Cannot deactivate yourself");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).active).toBe(true);
  });
});

describe("last active administrator protection", () => {
  let soleAdmin: UserRow;
  /** Caller passes the gate via an admin.users grant, so soleAdmin really is the last active ADMIN. */
  let caller: UserRow;

  beforeAll(async () => {
    soleAdmin = await createUser("ADMIN", "last-admin");
    caller = await createUser("USER", "last-admin-caller");
    await prisma.userPermission.create({ data: { userId: caller.id, key: "admin.users", allowed: true } });
  });

  it("rejects demoting the last active administrator", async () => {
    await withSoleActiveAdmin(soleAdmin.id, async () => {
      login(caller);
      const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: soleAdmin.id, role: "USER" } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Cannot demote or deactivate the last active administrator");
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } })).role).toBe("ADMIN");
  });

  it("rejects deactivating the last active administrator", async () => {
    await withSoleActiveAdmin(soleAdmin.id, async () => {
      login(caller);
      const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: soleAdmin.id, active: false } }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Cannot demote or deactivate the last active administrator");
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: soleAdmin.id } })).active).toBe(true);
  });

  it("rejects deleting the last active administrator", async () => {
    await withSoleActiveAdmin(soleAdmin.id, async () => {
      login(caller);
      const res = await usersDELETE(req(`${USERS_URL}?id=${soleAdmin.id}`, { method: "DELETE" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Cannot delete the last active administrator");
    });
    expect(await prisma.user.count({ where: { id: soleAdmin.id } })).toBe(1);
  });

  it("rejects removing admin.users from the last active administrator via the permissions API", async () => {
    await withSoleActiveAdmin(soleAdmin.id, async () => {
      login(caller);
      const res = await putOverrides(soleAdmin.id, [{ key: "admin.users", allowed: false }]);
      expect(res.status).toBe(400);
    });
    expect(await prisma.userPermission.count({ where: { userId: soleAdmin.id, key: "admin.users" } })).toBe(0);
  });
});

describe("permission change effects (PUT /api/permissions)", () => {
  it("a permission change bumps sessionVersion and is audited", async () => {
    const target = await createUser("ADVISOR", "grant", { password: "am-grant-secret-pw" });
    login(admin);

    const res = await putOverrides(target.id, [{ key: "whatsapp.inbox.view", allowed: true }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.id).toBe(target.id);
    expect(body.user.overrides).toContainEqual({ key: "whatsapp.inbox.view", allowed: true });
    expect(body.user.effective).toContain("whatsapp.inbox.view");

    expect(await sessionVersionOf(target.id)).toBe(1);

    const row = await prisma.userPermission.findUnique({
      where: { userId_key: { userId: target.id, key: "whatsapp.inbox.view" } },
    });
    expect(row?.allowed).toBe(true);

    // Attributed to the caller, mentions the target and the changed keys, and
    // never leaks the target's password into the audit trail.
    const audits = await permAuditRows(target.email);
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(admin.id);
    expect(audits[0].details).toContain("whatsapp.inbox.view");
    expect(audits[0].details).not.toContain("am-grant-secret-pw");
  });

  it("resetting an override to default removes the row", async () => {
    const target = await createUser("ADVISOR", "reset");
    login(admin);

    const grant = await putOverrides(target.id, [{ key: "whatsapp.inbox.view", allowed: true }]);
    expect(grant.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);

    const res = await putOverrides(target.id, [{ key: "whatsapp.inbox.view", allowed: null }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.overrides ?? []).toHaveLength(0);
    // Back to the bare ADVISOR preset, which has no inbox keys.
    expect(body.user.effective).not.toContain("whatsapp.inbox.view");

    expect(await prisma.userPermission.count({ where: { userId: target.id } })).toBe(0);
    // The reset is itself a permission change: one more session bump.
    expect(await sessionVersionOf(target.id)).toBe(2);
  });

  it("a PUT whose overrides change nothing performs no session bump and writes no audit", async () => {
    const target = await createUser("USER", "noop");
    login(admin);

    const grant = { key: "travel.review", allowed: true };
    expect((await putOverrides(target.id, [grant])).status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);
    expect(await permAuditRows(target.email)).toHaveLength(1);

    // Identical overrides again: nothing to change.
    expect((await putOverrides(target.id, [grant])).status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);
    expect(await permAuditRows(target.email)).toHaveLength(1);
  });
});

// This describe MUST stay before "migration report confirmation": confirming
// the report is global and permanent, and would unlock internal-cost grants
// for every later test in the file.
describe("internal-cost grant lock (migration unconfirmed)", () => {
  it("internal-cost grants stay locked until the report is confirmed", async () => {
    const advTarget = await createUser("ADVISOR", "lock-advisor");
    const admTarget = await createUser("ADMIN", "lock-admin");
    login(admin);

    for (const key of ["travel.internal.view", "travel.internal.download"]) {
      const res = await putOverrides(advTarget.id, [{ key, allowed: true }]);
      expect(res.status).toBe(403);
    }
    expect(await prisma.userPermission.count({ where: { userId: advTarget.id } })).toBe(0);
    expect(await sessionVersionOf(advTarget.id)).toBe(0);

    // ADMIN-role targets are locked too: their preset already holds the keys,
    // and an orphan grant row would survive a later demotion.
    const locked = await putOverrides(admTarget.id, [{ key: "travel.internal.view", allowed: true }]);
    expect(locked.status).toBe(403);
    expect(await prisma.userPermission.count({ where: { userId: admTarget.id } })).toBe(0);
    expect(await sessionVersionOf(admTarget.id)).toBe(0);
  });

  it("demoting an administrator holding an internal-cost grant is rejected while unconfirmed", async () => {
    // A legacy grant row (e.g. written before the lock tightened) — the PUT
    // above can no longer create one, so seed it directly.
    const target = await createUser("ADMIN", "lock-demote");
    await prisma.userPermission.create({
      data: { userId: target.id, key: "travel.internal.view", allowed: true },
    });
    login(admin);

    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, role: "USER" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("internal");

    // The demotion did not happen: role, grant row and sessionVersion unchanged.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.role).toBe("ADMIN");
    expect(after.sessionVersion).toBe(0);
    expect(
      await prisma.userPermission.count({
        where: { userId: target.id, key: "travel.internal.view", allowed: true },
      }),
    ).toBe(1);

    // Removing the grant first unblocks the demotion.
    await prisma.userPermission.deleteMany({ where: { userId: target.id } });
    const ok = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, role: "USER" } }));
    expect(ok.status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("USER");
  });
});

describe("GET /api/permissions/report", () => {
  it("the report lists every existing user with preset-derived permissions", async () => {
    const repAdmin = await createUser("ADMIN", "rep-admin");
    const repUser = await createUser("USER", "rep-user");
    const repAdvisor = await createUser("ADVISOR", "rep-advisor");
    const repValidator = await createUser("VALIDATOR", "rep-validator");

    login(admin);
    const res = await reportGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Unconfirmed at this point in the file (see ordering note).
    expect(body.confirmed).toBe(false);
    expect(body.confirmedAt).toBeNull();
    expect(body.confirmedBy).toBeNull();

    // EVERY existing user is listed, not just a page or a subset.
    expect(body.users).toHaveLength(await prisma.user.count());

    const byId = new Map<string, any>(body.users.map((u: any): [string, any] => [u.id, u]));
    expect(sorted(byId.get(repAdmin.id)?.proposed ?? [])).toEqual(sorted([...PERMISSION_KEYS]));
    expect(sorted(byId.get(repUser.id)?.proposed ?? [])).toEqual(
      sorted(["whatsapp.inbox.view", "whatsapp.inbox.send"]),
    );
    expect(sorted(byId.get(repAdvisor.id)?.proposed ?? [])).toEqual(
      sorted(["travel.access", "travel.create", "travel.issue", "travel.client_docs.download", "travel.client_docs.send"]),
    );
    expect(sorted(byId.get(repValidator.id)?.proposed ?? [])).toEqual(
      sorted(["travel.access", "travel.review", "travel.client_docs.download", "travel.client_docs.send"]),
    );
  });
});

describe("migration report confirmation", () => {
  it("the confirmation is recorded once", async () => {
    login(admin);

    const first = await reportPOST();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.confirmed).toBe(true);
    expect(typeof firstBody.confirmedAt).toBe("string");

    const audit = await prisma.log.findFirst({
      where: { action: "PERMISSIONS_MIGRATION_CONFIRMED", userId: admin.id },
    });
    expect(audit).toBeTruthy();

    const report = await reportGET();
    const reportBody = await report.json();
    expect(reportBody.confirmed).toBe(true);
    expect(reportBody.confirmedBy).toBe(admin.email);
    expect(reportBody.confirmedAt).toBe(firstBody.confirmedAt);

    const second = await reportPOST();
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("Proposed permissions already confirmed");
    expect(await prisma.log.count({ where: { action: "PERMISSIONS_MIGRATION_CONFIRMED" } })).toBe(1);
  });
});

describe("internal-cost grants after confirmation", () => {
  it("internal-cost grants are allowed once confirmed", async () => {
    const target = await createUser("ADVISOR", "post-confirm");
    login(admin);

    const res = await putOverrides(target.id, [{ key: "travel.internal.view", allowed: true }]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.user.effective).toContain("travel.internal.view");
    expect(
      await prisma.userPermission.count({
        where: { userId: target.id, key: "travel.internal.view", allowed: true },
      }),
    ).toBe(1);
  });

  it("demoting an administrator holding an internal-cost grant succeeds once confirmed", async () => {
    const target = await createUser("ADMIN", "post-confirm-demote");
    login(admin);
    const grant = await putOverrides(target.id, [{ key: "travel.internal.view", allowed: true }]);
    expect(grant.status).toBe(200);

    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, role: "USER" } }));
    expect(res.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.role).toBe("USER");
    // After confirmation a non-admin may hold internal keys, so the row stays.
    expect(
      await prisma.userPermission.count({
        where: { userId: target.id, key: "travel.internal.view", allowed: true },
      }),
    ).toBe(1);
  });
});

describe("users route regression (perm-admin edits)", () => {
  it("a plain USER still gets 401 (not 403) from PATCH /api/users", async () => {
    const target = await createUser("USER", "patch-target");
    login(plainUser);
    const res = await usersPATCH(req(USERS_URL, { method: "PATCH", body: { id: target.id, name: "Nope" } }));
    expect(res.status).toBe(401);
  });

  it("DELETE with an unknown id answers 404", async () => {
    login(admin);
    const res = await usersDELETE(req(`${USERS_URL}?id=am-no-such-user`, { method: "DELETE" }));
    expect(res.status).toBe(404);
  });

  it("self-delete stays 400", async () => {
    login(admin);
    const res = await usersDELETE(req(`${USERS_URL}?id=${admin.id}`, { method: "DELETE" }));
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { id: admin.id } })).toBe(1);
  });
});

describe("revoke-sessions permission gate", () => {
  it("a USER granted admin.users can revoke sessions; a plain USER cannot", async () => {
    const target = await createUser("USER", "revoke-target");

    login(plainUser);
    const denied = await revokePOST(req(REVOKE_URL(target.id), { method: "POST" }), {
      params: Promise.resolve({ id: target.id }),
    });
    expect(denied.status).toBe(403);
    expect(await sessionVersionOf(target.id)).toBe(0);

    login(grantedUser);
    const res = await revokePOST(req(REVOKE_URL(target.id), { method: "POST" }), {
      params: Promise.resolve({ id: target.id }),
    });
    expect(res.status).toBe(200);
    expect(await sessionVersionOf(target.id)).toBe(1);
  });
});
