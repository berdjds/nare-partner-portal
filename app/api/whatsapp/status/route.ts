import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { accountPermissions } from "@/lib/permissions";
import { MARHABA_ACCOUNT_KEY } from "@/lib/whatsapp-accounts";
import { getWhatsAppState, logoutWhatsApp, initializeWhatsApp, restartWhatsApp } from "@/lib/whatsapp";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // W2/W3 permission policy: full connection details — including the pairing
  // QR — require the account's admin permission (whatsapp.admin for marhaba,
  // whatsapp.nare.admin for nare). Anyone with the account's view permission
  // sees availability strictly as { connected } (the pre-W3 payload shape —
  // the account is identified by the ?account= query, not the response).
  // Everyone else gets 403, deactivated users 401. Resolved from the current
  // DB row, so an override edit takes effect on the next request.
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accountKey = new URL(req.url).searchParams.get("account") || MARHABA_ACCOUNT_KEY;
  const perms = accountPermissions(accountKey);
  if (!perms) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }

  if (user.permissions.has(perms.admin)) {
    return NextResponse.json(getWhatsAppState(accountKey));
  }

  if (user.permissions.has(perms.view)) {
    return NextResponse.json({ connected: getWhatsAppState(accountKey).state === "ready" });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  // Requires the account's admin permission; callers without it (logged in or
  // not) get the same 401 as before W1, now additionally enforced against the
  // live DB row, per-user overrides and the target account.
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const accountKey = typeof body.account === "string" && body.account ? body.account : MARHABA_ACCOUNT_KEY;
  const perms = accountPermissions(accountKey);
  if (!perms) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }
  if (!user.permissions.has(perms.admin)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (body.action === "logout") {
    await logoutWhatsApp(accountKey);
    // Re-initialize after logout so a new QR is generated
    setTimeout(() => initializeWhatsApp(accountKey).catch(() => null), 1000);
    return NextResponse.json({ ok: true, ...getWhatsAppState(accountKey) });
  }

  if (body.action === "reconnect") {
    setTimeout(
      () => restartWhatsApp(accountKey).catch((e) => console.error("[API /whatsapp/status] reconnect error:", e)),
      1000
    );
    return NextResponse.json({ ok: true, ...getWhatsAppState(accountKey) });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
