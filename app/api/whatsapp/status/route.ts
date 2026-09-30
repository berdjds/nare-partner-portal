import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser, requireWhatsAppAdminAccess } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { getWhatsAppState, logoutWhatsApp, initializeWhatsApp, restartWhatsApp } from "@/lib/whatsapp";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // W2 permission policy (lib/permissions.ts): full connection details —
  // including the pairing QR — require the effective whatsapp.admin
  // permission. Anyone with whatsapp.inbox.view sees availability strictly as
  // { connected }. Everyone else gets 403, deactivated users 401. Resolved
  // from the current DB row, so an override edit takes effect on the next
  // request.
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (hasPermission(user, "whatsapp.admin")) {
    return NextResponse.json(getWhatsAppState());
  }

  if (hasPermission(user, "whatsapp.inbox.view")) {
    return NextResponse.json({ connected: getWhatsAppState().state === "ready" });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  // Requires the effective whatsapp.admin permission; callers without it
  // (logged in or not) get the same 401 as before W1, now additionally
  // enforced against the live DB row and per-user overrides.
  const session = await getServerSession(authOptions);
  const access = await requireWhatsAppAdminAccess(session);
  if (!access.allowed) return access.response;

  const body = await req.json().catch(() => ({}));
  if (body.action === "logout") {
    await logoutWhatsApp();
    // Re-initialize after logout so a new QR is generated
    setTimeout(() => initializeWhatsApp().catch(() => null), 1000);
    return NextResponse.json({ ok: true, ...getWhatsAppState() });
  }

  if (body.action === "reconnect") {
    setTimeout(() => restartWhatsApp().catch((e) => console.error("[API /whatsapp/status] reconnect error:", e)), 1000);
    return NextResponse.json({ ok: true, ...getWhatsAppState() });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
