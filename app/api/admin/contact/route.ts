import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { ContactError, history, saveDraft, SCOPES } from "@/lib/contact/service";
import { DEFAULT_CONTACT } from "@/lib/contact/schema";

async function actor() {
  const user = await getActiveUser(await getServerSession(authOptions));
  return user && hasPermission(user, "admin.settings") ? user : null;
}
const fail = (e: unknown) => {
  if (e instanceof ContactError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
  console.error("[API /admin/contact]", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
};

// GET ?scope=global|portal -> version history (newest first) and the built-in defaults.
export async function GET(req: NextRequest) {
  if (!(await actor())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const scope = req.nextUrl.searchParams.get("scope") ?? "portal";
  try { return NextResponse.json({ scopes: SCOPES, defaults: DEFAULT_CONTACT, history: await history(scope) }); } catch (e) { return fail(e); }
}

// PUT { scope, data, note? } -> saves a DRAFT version (never live until published).
export async function PUT(req: NextRequest) {
  const user = await actor();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  try { return NextResponse.json(await saveDraft(user, String(body.scope), body.data, typeof body.note === "string" ? body.note : undefined)); } catch (e) { return fail(e); }
}
