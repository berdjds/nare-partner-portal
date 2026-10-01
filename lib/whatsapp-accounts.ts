/**
 * W3: registry of WhatsApp business accounts (WhatsAppAccount rows).
 *
 * Two accounts exist from the start:
 *  - marhaba: the existing Marhaba Armenia account. It keeps the legacy
 *    LocalAuth session (no clientId — .wwebjs_auth/session stays untouched)
 *    and is enabled, so releasing this phase changes nothing for it.
 *  - nare: the new Nare Travel and Tours account, created DISABLED. The owner
 *    enables and pairs it (QR) after release; until then no Nare client runs.
 *
 * ensureDefaultAccounts() is called from the deploy bootstrap seed
 * (prisma/seed.ts). It is idempotent and never modifies an existing row, so
 * owner configuration (display name, numbers, enabled) survives every deploy.
 */

import { prisma } from "@/lib/prisma";
import type { WhatsAppAccount } from "@prisma/client";

export const MARHABA_ACCOUNT_ID = "marhaba";
export const MARHABA_ACCOUNT_KEY = "marhaba";
export const NARE_ACCOUNT_ID = "nare";
export const NARE_ACCOUNT_KEY = "nare";

export const DEFAULT_TRAVEL_ACCOUNT_KEY = NARE_ACCOUNT_KEY;

const DEFAULT_ACCOUNTS: ReadonlyArray<{
  id: string;
  key: string;
  displayName: string;
  enabled: boolean;
  sessionClientId: string | null;
  purpose: string;
}> = [
  {
    id: MARHABA_ACCOUNT_ID,
    key: MARHABA_ACCOUNT_KEY,
    displayName: "Marhaba Armenia",
    enabled: true,
    // No clientId: LocalAuth keeps using the existing .wwebjs_auth/session
    // directory so the live Marhaba session is preserved untouched.
    sessionClientId: null,
    purpose: "INBOX",
  },
  {
    id: NARE_ACCOUNT_ID,
    key: NARE_ACCOUNT_KEY,
    displayName: "Nare Travel and Tours",
    // Ships disabled: no Nare client is created until the owner enables and
    // pairs the account. LocalAuth uses clientId 'nare' (session-nare).
    enabled: false,
    sessionClientId: NARE_ACCOUNT_KEY,
    purpose: "TRAVEL",
  },
];

export async function getAccount(key: string): Promise<WhatsAppAccount | null> {
  return prisma.whatsAppAccount.findUnique({ where: { key } });
}

export async function listAccounts(): Promise<WhatsAppAccount[]> {
  return prisma.whatsAppAccount.findMany({ orderBy: { key: "asc" } });
}

/**
 * Creates the default account rows that are missing; never touches an
 * existing row (checked by key, so a pre-existing row wins even if it was
 * created with a different id). Safe to run on every deploy.
 */
export async function ensureDefaultAccounts(): Promise<WhatsAppAccount[]> {
  for (const spec of DEFAULT_ACCOUNTS) {
    const existing = await prisma.whatsAppAccount.findUnique({ where: { key: spec.key } });
    if (!existing) {
      await prisma.whatsAppAccount.create({ data: spec });
    }
  }
  return listAccounts();
}

/**
 * The account every travel-module WhatsApp send must go through:
 * TravelSettings.whatsappAccountKey (default 'nare'). There is deliberately
 * no fallback to another account — a missing row is a configuration error the
 * owner must fix, not a reason to send from Marhaba.
 */
export async function resolveTravelAccount(): Promise<WhatsAppAccount> {
  await ensureDefaultAccounts();
  const { getTravelSettings } = await import("@/lib/travel/settings");
  const settings = await getTravelSettings();
  const account = await getAccount(settings.whatsappAccountKey);
  if (!account) {
    throw new Error(
      `Travel WhatsApp account "${settings.whatsappAccountKey}" is not configured. ` +
        `Set TravelSettings.whatsappAccountKey to an existing WhatsApp account key.`
    );
  }
  return account;
}
