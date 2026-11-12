import { canViewInternal } from "@/lib/travel/redact";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTravelActor, travelError, unauthorized } from "../guard";

// Import batches with per-status row counts.
export async function GET() {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  // Workbook import rows carry supplier costs: internal permission only (D3).
  if (!canViewInternal(actor)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const batches = await prisma.importBatch.findMany({
      orderBy: { createdAt: "desc" },
      include: { rows: { select: { status: true } } },
    });
    return NextResponse.json(
      batches.map((b) => {
        const counts: Record<string, number> = {};
        for (const row of b.rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
        const { rows: _rows, ...meta } = b;
        return { ...meta, rowCount: b.rows.length, counts };
      }),
    );
  } catch (err) {
    return travelError(err, "[API /travel/imports]");
  }
}
