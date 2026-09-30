import { NextRequest, NextResponse } from "next/server";
import { saveVersionContent, saveVersionContentSchema } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

// Replaces scenario/stay, service-line and itinerary collections of a DRAFT
// or CHANGES_REQUESTED version (see saveVersionContent).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = saveVersionContentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const version = await saveVersionContent(actor, id, parsed.data);
    return NextResponse.json(version);
  } catch (err) {
    return travelError(err, "[API /travel/versions/[id]/content]");
  }
}
