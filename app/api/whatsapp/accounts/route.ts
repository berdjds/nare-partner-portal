import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser, type ActiveUser } from "@/lib/access-policy";
import { accountPermissions, ACCOUNT_PERMISSIONS } from "@/lib/permissions";
import { ensureDefaultAccounts } from "@/lib/whatsapp-accounts";
import { getWhatsAppState, initializeWhatsApp, logoutWhatsApp, restartWhatsApp, stopWhatsAppClient } from "@/lib/whatsapp";
import { writeAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

/**
 * W3 (wa-multi) admin API for the WhatsApp business accounts: list, configure
 * (display name, public number, enabled), connect/pair (QR), reconnect and
 * disconnect — per account. Each account is gated by its own admin permission
 * (whatsapp.admin for marhaba, whatsapp.nare.admin for nare); a caller
 * without the target account's admin permission gets 401, matching the
 * pre-W1 /api/whatsapp/status contract.
 */

function isAccountAdmin(user: ActiveUser, accountKey: string): boolean {
  const perms = accountPermissions(accountKey);
  return perms !== null && user.permissions.has(perms.admin);
}

function isAnyAccountAdmin(user: ActiveUser): boolean {
  return Object.keys(ACCOUNT_PERMISSIONS).some((key) => isAccountAdmin(user, key));
}

const configureSchema = z.object({
  action: z.literal("configure"),
  account: z.string().min(1),
  displayName: z.string().min(1).optional(),
  publicNumber: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const actionSchema = z.object({
  action: z.enum(["connect", "reconnect", "disconnect"]),
  account: z.string().min(1),
});

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAnyAccountAdmin(user)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await ensureDefaultAccounts();
  const accounts = await prisma.whatsAppAccount.findMany({ orderBy: { key: "asc" } });

  // A caller sees full details (including runtime state and the pairing QR)
  // only for the accounts they may administer.
  const visible = accounts.filter((account) => isAccountAdmin(user, account.key));
  return NextResponse.json(
    visible.map((account) => ({
      key: account.key,
      displayName: account.displayName,
      enabled: account.enabled,
      purpose: account.purpose,
      publicNumber: account.publicNumber,
      verifiedNumber: account.verifiedNumber,
      state: getWhatsAppState(account.key),
    }))
  );
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const raw = await req.json().catch(() => ({}));
  let body: z.infer<typeof configureSchema> | z.infer<typeof actionSchema>;
  const parsedConfigure = configureSchema.safeParse(raw);
  if (parsedConfigure.success) {
    body = parsedConfigure.data;
  } else {
    const parsedAction = actionSchema.safeParse(raw);
    if (!parsedAction.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    body = parsedAction.data;
  }

  const accountKey = body.account;
  if (!accountPermissions(accountKey)) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }
  if (!isAccountAdmin(user, accountKey)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureDefaultAccounts();

  if (body.action === "configure") {
    const data: { displayName?: string; publicNumber?: string | null; enabled?: boolean } = {};
    if (body.displayName !== undefined) data.displayName = body.displayName;
    if (body.publicNumber !== undefined) data.publicNumber = body.publicNumber;
    if (body.enabled !== undefined) data.enabled = body.enabled;

    const account = await prisma.whatsAppAccount.update({ where: { key: accountKey }, data });

    // A disabled account must not keep a client running; the on-disk session
    // is preserved so re-enabling + connect resumes without a new pairing.
    if (data.enabled === false) {
      await stopWhatsAppClient(accountKey);
    }

    await writeAuditLog(
      "WA_ACCOUNT_CONFIGURE",
      user.id,
      `[${accountKey}] ` +
        [
          data.displayName !== undefined ? `displayName="${data.displayName}"` : null,
          data.publicNumber !== undefined ? `publicNumber=${data.publicNumber ?? "cleared"}` : null,
          data.enabled !== undefined ? `enabled=${data.enabled}` : null,
        ]
          .filter(Boolean)
          .join(" ")
    );

    return NextResponse.json({
      ok: true,
      account: {
        key: account.key,
        displayName: account.displayName,
        enabled: account.enabled,
        purpose: account.purpose,
        publicNumber: account.publicNumber,
        verifiedNumber: account.verifiedNumber,
        state: getWhatsAppState(accountKey),
      },
    });
  }

  // body.action is "connect" | "reconnect" | "disconnect" here (configure
  // returned above).
  const action = body.action;
  if (action === "connect") {
    await writeAuditLog("WA_ACCOUNT_CONNECT", user.id, `[${accountKey}] connect requested`);
    // Async: pairing (QR) progresses via the account's whatsapp_state emits.
    setTimeout(() => initializeWhatsApp(accountKey).catch(() => null), 100);
  } else if (action === "reconnect") {
    await writeAuditLog("WA_ACCOUNT_RECONNECT", user.id, `[${accountKey}] reconnect requested`);
    setTimeout(
      () => restartWhatsApp(accountKey).catch((e) => console.error("[API /whatsapp/accounts] reconnect error:", e)),
      100
    );
  } else {
    await writeAuditLog("WA_ACCOUNT_DISCONNECT", user.id, `[${accountKey}] disconnect requested`);
    await logoutWhatsApp(accountKey);
  }

  return NextResponse.json({ ok: true, ...getWhatsAppState(accountKey) });
}
