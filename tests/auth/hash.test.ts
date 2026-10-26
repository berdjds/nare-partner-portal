/**
 * W7b hash-cost tests (lib/security/hash.ts + the rehash step in
 * lib/auth.ts authorize).
 *
 * Pins: every new hash is bcrypt cost HASH_COST (12); a sign-in against a
 * pre-W7b cost-10 hash succeeds AND upgrades the stored hash to cost 12 as
 * one extra update that never touches sessionVersion; a failed sign-in
 * never rehashes. authorize() runs for real against a throwaway SQLite
 * database, like the neighboring auth.test.ts.
 */

import { beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { HASH_COST, hashPassword, needsRehash } from "@/lib/security/hash";

// Built at run time — tests must not carry credential-looking literals.
const plainText = () => `hash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

let prisma: PrismaClient;
let authOptions: typeof import("@/lib/auth").authOptions;
let emailCounter = 0;

function uniqueEmail(): string {
  emailCounter += 1;
  return `hash-test-${Date.now()}-${emailCounter}@test.io`;
}

/**
 * Same next-auth parseProviders() normalization as auth.test.ts: the real
 * authorize lives under the provider's `.options`, not at the top level.
 */
function credentialsProvider(): { authorize: (credentials: unknown) => Promise<unknown> } {
  const { options, ...rest } = authOptions.providers[0] as any;
  return { ...rest, ...options };
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  authOptions = (await import("@/lib/auth")).authOptions;
});

describe("lib/security/hash", () => {
  it("mints new hashes at cost 12 and does not flag them for rehash", async () => {
    const plain = plainText();
    const hash = await hashPassword(plain);
    expect(bcrypt.getRounds(hash)).toBe(HASH_COST);
    expect(HASH_COST).toBe(12);
    expect(needsRehash(hash)).toBe(false);
    expect(await bcrypt.compare(plain, hash)).toBe(true);
  });

  it("flags a legacy cost-10 hash for rehash", () => {
    const legacy = bcrypt.hashSync(plainText(), 10);
    expect(bcrypt.getRounds(legacy)).toBe(10);
    expect(needsRehash(legacy)).toBe(true);
  });
});

describe("rehash on sign-in (lib/auth.ts authorize)", () => {
  it("upgrades a cost-10 hash to cost 12 after a successful sign-in, sessionVersion unchanged", async () => {
    const plain = plainText();
    const user = await prisma.user.create({
      data: {
        email: uniqueEmail(),
        name: "Hash Upgrade",
        password: bcrypt.hashSync(plain, 10),
        role: "USER",
      },
    });

    const result: any = await credentialsProvider().authorize({
      email: user.email,
      password: plain,
    });
    expect(result).not.toBeNull();
    expect(result.id).toBe(user.id);
    expect(result.sv).toBe(0);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(bcrypt.getRounds(after.password)).toBe(HASH_COST);
    expect(after.sessionVersion).toBe(0);

    // The upgraded hash still authenticates the same password.
    const again: any = await credentialsProvider().authorize({
      email: user.email,
      password: plain,
    });
    expect(again).not.toBeNull();
    expect(again.id).toBe(user.id);
  });

  it("leaves an up-to-date hash untouched on sign-in", async () => {
    const plain = plainText();
    const current = await hashPassword(plain);
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), name: "Hash Current", password: current, role: "USER" },
    });

    const result: any = await credentialsProvider().authorize({
      email: user.email,
      password: plain,
    });
    expect(result).not.toBeNull();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.password).toBe(current);
    expect(after.sessionVersion).toBe(0);
  });

  it("never rehashes on a failed sign-in", async () => {
    const plain = plainText();
    const legacy = bcrypt.hashSync(plain, 10);
    const user = await prisma.user.create({
      data: { email: uniqueEmail(), name: "Hash Failure", password: legacy, role: "USER" },
    });

    const result = await credentialsProvider().authorize({
      email: user.email,
      password: `wrong-${plain}`,
    });
    expect(result).toBeNull();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.password).toBe(legacy);
    expect(after.sessionVersion).toBe(0);
  });
});
