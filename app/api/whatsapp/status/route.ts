import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { canAdministerWhatsApp, canUseInbox, getActiveUser, requireWhatsAppAdminAccess } from "@/lib/access-policy";
import { getWhatsAppState, logoutWhatsApp, initializeWhatsApp, restartWhatsApp } from "@/lib/whatsapp";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Interim W1 policy (lib/access-policy.ts): full connection details —
  // including the pairing QR — are ADMIN-only. USER (and any future inbox
  // role) sees availability strictly as { connected }. Travel-only roles get
  // 403, deactivated users 401. Decided from the current DB role, so a role
  // change takes effect on the next request.
  const user = await getActiveUser(session);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (canAdministerWhatsApp(user.role)) {
    return NextResponse.json(getWhatsAppState());
  }

  if (canUseInbox(user.role)) {
    return NextResponse.json({ connected: getWhatsAppState().state === "ready" });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  // Stays ADMIN-only; non-admins (logged in or not) get the same 401 as before
  // W1, now additionally enforced against the live DB role/active flag.
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
