import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { ContactError, publish } from "@/lib/contact/service";

// POST { id } -> publishes a draft (supersedes the previous published version).
export async function POST(req: NextRequest) {
  const user = await getActiveUser(await getServerSession(authOptions));
  if (!user || !hasPermission(user, "admin.settings")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  try { return NextResponse.json(await publish(user, body.id)); }
  catch (e) {
    if (e instanceof ContactError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
    console.error("[API /admin/contact/publish]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
