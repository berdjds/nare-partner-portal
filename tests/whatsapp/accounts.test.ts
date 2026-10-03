/**
 * W3 account-registry tests (lib/whatsapp-accounts.ts) against a throwaway
 * SQLite database (same pattern as tests/travel-db).
 *
 * Pins the acceptance behaviour:
 *  - ensureDefaultAccounts() creates the ENABLED Marhaba account and the
 *    DISABLED Nare account with the fixed ids/keys
 *  - it is idempotent (running it again changes nothing)
 *  - it never overwrites an existing account row (owner configuration such as
 *    display name, numbers and the enabled switch survives every deploy)
 *  - resolveTravelAccount() follows TravelSettings.whatsappAccountKey and
 *    fails loudly (never falls back to another account) on a bad key
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

let prisma: PrismaClient;
let accounts: typeof import("@/lib/whatsapp-accounts");

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  accounts = await import("@/lib/whatsapp-accounts");
});

describe("ensureDefaultAccounts", () => {
  it("creates Marhaba enabled and Nare disabled with fixed ids/keys", async () => {
    await accounts.ensureDefaultAccounts();

    const marhaba = await accounts.getAccount("marhaba");
    expect(marhaba).toBeTruthy();
    expect(marhaba!.id).toBe("marhaba");
    expect(marhaba!.displayName).toBe("Marhaba Armenia");
    expect(marhaba!.enabled).toBe(true);
    // No clientId: the legacy .wwebjs_auth/session directory stays untouched.
    expect(marhaba!.sessionClientId).toBeNull();
    expect(marhaba!.purpose).toBe("INBOX");

    const nare = await accounts.getAccount("nare");
    expect(nare).toBeTruthy();
    expect(nare!.id).toBe("nare");
    expect(nare!.displayName).toBe("Nare Travel and Tours");
    expect(nare!.enabled).toBe(false);
    // LocalAuth clientId 'nare' -> session-nare, separate from Marhaba.
    expect(nare!.sessionClientId).toBe("nare");
    expect(nare!.purpose).toBe("TRAVEL");
  });

  it("is idempotent: a second run creates nothing and changes nothing", async () => {
    const before = await accounts.listAccounts();
    await accounts.ensureDefaultAccounts();
    const after = await accounts.listAccounts();

    expect(after).toHaveLength(2);
    expect(after.map((a) => a.id).sort()).toEqual(["marhaba", "nare"]);
    expect(after).toEqual(before);
  });

  it("never overwrites an existing account row", async () => {
    // Owner configures the accounts after release: renames Marhaba, disables
    // it, publishes a number; enables Nare and sets its public number.
    await prisma.whatsAppAccount.update({
      where: { key: "marhaba" },
      data: { displayName: "Marhaba Armenia LLC", enabled: false, publicNumber: "37410000001" },
    });
    await prisma.whatsAppAccount.update({
      where: { key: "nare" },
      data: { enabled: true, publicNumber: "37495000002", verifiedNumber: "37495000002" },
    });

    await accounts.ensureDefaultAccounts();

    const marhaba = await accounts.getAccount("marhaba");
    expect(marhaba!.displayName).toBe("Marhaba Armenia LLC");
    expect(marhaba!.enabled).toBe(false);
    expect(marhaba!.publicNumber).toBe("37410000001");

    const nare = await accounts.getAccount("nare");
    expect(nare!.enabled).toBe(true);
    expect(nare!.publicNumber).toBe("37495000002");
    expect(nare!.verifiedNumber).toBe("37495000002");
  });

  it("restores a deleted default row without touching the surviving one", async () => {
    await prisma.whatsAppAccount.delete({ where: { key: "nare" } });
    await accounts.ensureDefaultAccounts();

    const nare = await accounts.getAccount("nare");
    expect(nare).toBeTruthy();
    expect(nare!.enabled).toBe(false); // recreated from the default spec

    const marhaba = await accounts.getAccount("marhaba");
    expect(marhaba!.displayName).toBe("Marhaba Armenia LLC"); // untouched
  });
});

describe("resolveTravelAccount", () => {
  it("returns the Nare account by default (TravelSettings.whatsappAccountKey defaults to 'nare')", async () => {
    const account = await accounts.resolveTravelAccount();
    expect(account.key).toBe("nare");
    expect(account.id).toBe("nare");
  });

  it("follows a changed TravelSettings.whatsappAccountKey", async () => {
    await prisma.travelSettings.update({
      where: { id: "default" },
      data: { whatsappAccountKey: "marhaba" },
    });
    const account = await accounts.resolveTravelAccount();
    expect(account.key).toBe("marhaba");
  });

  it("throws a clear error for an unknown key instead of falling back", async () => {
    await prisma.travelSettings.update({
      where: { id: "default" },
      data: { whatsappAccountKey: "nonexistent" },
    });
    await expect(accounts.resolveTravelAccount()).rejects.toThrow(/nonexistent/);
    // Restore the default for any later use in this file.
    await prisma.travelSettings.update({
      where: { id: "default" },
      data: { whatsappAccountKey: "nare" },
    });
  });
});
