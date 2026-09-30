/**
 * Authentication regression tests (W1): pins lib/auth.ts behaviour so later
 * W1 tasks and the Next 15 upgrade are proven not to change it.
 *
 * authorize() runs for real against a throwaway SQLite database — bcrypt
 * hashing/comparison included. The jwt/session callbacks are invoked
 * directly with the same shapes NextAuth 4 passes at runtime.
 */

import { beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const PASSWORD = "correct horse battery staple";

let prisma: PrismaClient;
let authOptions: typeof import("@/lib/auth").authOptions;
let activeAdmin: { id: string; email: string; name: string | null; role: string };
let inactiveUser: { id: string; email: string };

/**
 * The credentials provider as next-auth's parseProviders() normalizes it for
 * the credentials callback route: CredentialsProvider() nests the
 * user-supplied authorize under `.options` (the top-level `authorize` is a
 * `() => null` stub — see node_modules/next-auth/providers/credentials.js),
 * and parseProviders merges `...options` over the provider at request time
 * (node_modules/next-auth/core/lib/providers.js). Spreading here reproduces
 * that merge so the tests exercise the real lib/auth.ts authorize instead of
 * the stub; with the stub, every "rejects ..." test passed vacuously.
 */
function credentialsProvider(): { authorize: (credentials: unknown) => Promise<unknown> } {
  const { options, ...rest } = authOptions.providers[0] as any;
  return { ...rest, ...options };
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  authOptions = (await import("@/lib/auth")).authOptions;

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const admin = await prisma.user.create({
    data: { email: "auth-admin@test.io", name: "Auth Admin", password: hash, role: "ADMIN" },
  });
  activeAdmin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role };
  const disabled = await prisma.user.create({
    data: {
      email: "auth-inactive@test.io",
      name: "Auth Inactive",
      password: bcrypt.hashSync(PASSWORD, 10),
      role: "USER",
      active: false,
    },
  });
  inactiveUser = { id: disabled.id, email: disabled.email };
});

describe("credentials authorize()", () => {
  it("accepts a correct bcrypt password and returns the user identity", async () => {
    const result: any = await credentialsProvider().authorize({
      email: activeAdmin.email,
      password: PASSWORD,
    });
    expect(result).not.toBeNull();
    expect(result.id).toBe(activeAdmin.id);
    expect(result.email).toBe(activeAdmin.email);
    expect(result.name).toBe(activeAdmin.name);
    expect(result.role).toBe("ADMIN");
    // Never leak the password hash into the session-bound identity.
    expect(result.password).toBeUndefined();
  });

  it("returns the user's session version as sv (W1b; 0 for a user that was never revoked)", async () => {
    const result: any = await credentialsProvider().authorize({
      email: activeAdmin.email,
      password: PASSWORD,
    });
    expect(result).not.toBeNull();
    expect(result.sv).toBe(0);
    // Still no password leak alongside the new claim.
    expect(result.password).toBeUndefined();
  });

  it("returns the bumped session version after a revocation event (W1b)", async () => {
    const bumped = await prisma.user.create({
      data: {
        email: "auth-bumped@test.io",
        name: "Auth Bumped",
        password: bcrypt.hashSync(PASSWORD, 10),
        role: "USER",
      },
    });
    // Revoke all issued sessions: bump User.sessionVersion atomically (the
    // same { increment: 1 } update revokeAllSessions performs).
    await prisma.user.update({ where: { id: bumped.id }, data: { sessionVersion: { increment: 1 } } });

    const result: any = await credentialsProvider().authorize({
      email: bumped.email,
      password: PASSWORD,
    });
    expect(result).not.toBeNull();
    expect(result.sv).toBe(1);
  });

  it("rejects a wrong password with null", async () => {
    const result = await credentialsProvider().authorize({
      email: activeAdmin.email,
      password: "wrong password",
    });
    expect(result).toBeNull();
  });

  it("rejects a missing user with null", async () => {
    const result = await credentialsProvider().authorize({
      email: "nobody-here@test.io",
      password: PASSWORD,
    });
    expect(result).toBeNull();
  });

  it("rejects an inactive (deactivated) user with null", async () => {
    const result = await credentialsProvider().authorize({
      email: inactiveUser.email,
      password: PASSWORD,
    });
    expect(result).toBeNull();
  });

  it("rejects malformed credentials before touching the database", async () => {
    expect(await credentialsProvider().authorize({ email: "not-an-email", password: "x" })).toBeNull();
    expect(await credentialsProvider().authorize({ email: activeAdmin.email, password: "" })).toBeNull();
    expect(await credentialsProvider().authorize(null)).toBeNull();
  });
});

describe("jwt callback", () => {
  it("carries id and role onto the token when a user signs in", async () => {
    const token: any = {};
    const out: any = await (authOptions.callbacks!.jwt as any)({
      token,
      user: { id: activeAdmin.id, email: activeAdmin.email, role: "ADMIN" },
    });
    expect(out).toBe(token);
    expect(out.id).toBe(activeAdmin.id);
    expect(out.role).toBe("ADMIN");
  });

  it("leaves the token untouched on subsequent requests (no user argument)", async () => {
    const token: any = { id: activeAdmin.id, role: "ADMIN", iat: 123 };
    const out: any = await (authOptions.callbacks!.jwt as any)({ token });
    expect(out).toBe(token);
    expect(out.id).toBe(activeAdmin.id);
    expect(out.role).toBe("ADMIN");
  });

  it("stores the user's session version on the token at sign-in (W1b)", async () => {
    const token: any = {};
    const out: any = await (authOptions.callbacks!.jwt as any)({
      token,
      user: { id: activeAdmin.id, email: activeAdmin.email, role: "ADMIN", sv: 3 },
    });
    expect(out).toBe(token);
    expect(out.sv).toBe(3);
  });

  it("defaults token.sv to 0 when the signing-in user carries no sv (W1b)", async () => {
    const token: any = {};
    const out: any = await (authOptions.callbacks!.jwt as any)({
      token,
      user: { id: activeAdmin.id, email: activeAdmin.email, role: "ADMIN" },
    });
    expect(out).toBe(token);
    expect(out.sv).toBe(0);
  });

  it("leaves an existing token.sv untouched on subsequent requests (no user argument, W1b)", async () => {
    const token: any = { id: activeAdmin.id, role: "ADMIN", sv: 5, iat: 123 };
    const out: any = await (authOptions.callbacks!.jwt as any)({ token });
    expect(out).toBe(token);
    expect(out.sv).toBe(5);
  });
});

describe("session callback", () => {
  it("exposes id and role on session.user from the token", async () => {
    const session: any = { user: {}, expires: "2099-01-01" };
    const out: any = await (authOptions.callbacks!.session as any)({
      session,
      token: { id: activeAdmin.id, role: "ADMIN" },
    });
    expect(out).toBe(session);
    expect(out.user.id).toBe(activeAdmin.id);
    expect(out.user.role).toBe("ADMIN");
  });

  it("exposes sv on session.user from token.sv (W1b)", async () => {
    const session: any = { user: {}, expires: "2099-01-01" };
    const out: any = await (authOptions.callbacks!.session as any)({
      session,
      token: { id: activeAdmin.id, role: "ADMIN", sv: 3 },
    });
    expect(out).toBe(session);
    expect(out.user.sv).toBe(3);
  });

  it("defaults session.user.sv to 0 when the token has no sv claim (W1b)", async () => {
    const session: any = { user: {}, expires: "2099-01-01" };
    const out: any = await (authOptions.callbacks!.session as any)({
      session,
      token: { id: activeAdmin.id, role: "ADMIN" },
    });
    expect(out).toBe(session);
    expect(out.user.sv).toBe(0);
  });

  it("keeps jwt as the session strategy with a 7-day maxAge (credentials provider requires jwt, W1b)", () => {
    expect(authOptions.session).toEqual({ strategy: "jwt", maxAge: 7 * 24 * 60 * 60 });
    expect(authOptions.adapter).toBeUndefined();
  });
});
