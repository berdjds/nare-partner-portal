import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// Batch detail: rows with their issues.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const batch = await prisma.importBatch.findUnique({
      where: { id },
      include: { rows: { orderBy: { sourceRef: "asc" } } },
    });
    if (!batch) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(batch);
  } catch (err) {
    return travelError(err, "[API /travel/imports/[id]]");
  }
}
