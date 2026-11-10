import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recalculateFromTemplate, recalculateSchema } from "@/lib/travel/workflow";
import { sellSideGuidance } from "@/lib/travel/guidance";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

// POST /api/travel/requests/[id]/recalculate — re-derives the template-governed
// itinerary/lines from the request's current travellers and dates (server
// authoritative, idempotent, audited). Owner or ADMIN only, editable versions only;
// partners never reach it (default-deny guard). The response carries the diff
// summary and a SELL-SIDE price guidance only (lib/travel/guidance.ts): no rates,
// costs, margins or markups, for any role.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const parsed = recalculateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.errors }, { status: 400 });

  try {
    const recalculation = await recalculateFromTemplate(actor, id, parsed.data);
    const version = await prisma.quoteVersion.findFirst({ where: { requestId: id }, orderBy: { versionNo: "desc" }, select: { id: true } });
    const guidance = version ? await sellSideGuidance(version.id) : { available: false, reason: "NO_VERSION" };
    return NextResponse.json({ recalculation, guidance });
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/recalculate]");
  }
}
