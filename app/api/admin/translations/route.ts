import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { approve, history, I18nError, overview, reject, requestAiDraft, saveDraft, sourceText } from "@/lib/i18n/translations";
import { getTranslationProvider } from "@/lib/i18n/provider";

async function actor() {
  const user = await getActiveUser(await getServerSession(authOptions));
  return user && (hasPermission(user, "content.translate") || hasPermission(user, "content.approve")) ? user : null;
}
const fail = (e: unknown) => {
  if (e instanceof I18nError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
  console.error("[API /admin/translations]", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
};
const str = (v: unknown) => (typeof v === "string" ? v : "");

// GET ?locale=hy            -> overview of every translatable item with its state
// GET ?locale&entity&entityId&field -> source text, history and whether AI generation is available
export async function GET(req: NextRequest) {
  const user = await actor();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const locale = q.get("locale") ?? "hy";
  try {
    if (!q.get("entity")) return NextResponse.json({ items: await overview(locale), aiAvailable: getTranslationProvider() !== null });
    const k = { entity: str(q.get("entity")), entityId: str(q.get("entityId")), field: str(q.get("field")), locale };
    return NextResponse.json({ source: await sourceText(k.entity, k.entityId, k.field), history: await history(k), aiAvailable: getTranslationProvider() !== null });
  } catch (e) { return fail(e); }
}

// POST { action: "draft" | "ai" | "approve" | "reject", ... }
export async function POST(req: NextRequest) {
  const user = await actor();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const k = { entity: str(b.entity), entityId: str(b.entityId), field: str(b.field), locale: str(b.locale) };
  try {
    switch (b.action) {
      case "draft": return NextResponse.json(await saveDraft(user, { ...k, text: str(b.text) }), { status: 201 });
      case "ai": return NextResponse.json(await requestAiDraft(user, k, getTranslationProvider()), { status: 201 });
      case "approve": return NextResponse.json(await approve(user, str(b.id)));
      case "reject": await reject(user, str(b.id), typeof b.reason === "string" ? b.reason : undefined); return NextResponse.json({ ok: true });
      default: return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) { return fail(e); }
}
