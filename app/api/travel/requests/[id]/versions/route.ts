import { NextRequest, NextResponse } from "next/server";
import { createRevision } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

// Creates versionNo+1 as a DRAFT clone of the latest version's content.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const version = await createRevision(actor, id);
    return NextResponse.json(version, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/versions]");
  }
}
