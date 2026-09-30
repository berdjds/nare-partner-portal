import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const verifySchema = z.object({
  rowIds: z.array(z.string().min(1)).min(1),
});

// Marks staged import rows VERIFIED by id (ADMIN). Rows stay in the batch;
// activation into the catalog is a separate import-layer concern.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const res = await prisma.importRow.updateMany({
      where: { id: { in: parsed.data.rowIds }, batchId: id, status: "STAGED" },
      data: { status: "VERIFIED" },
    });
    await writeAuditLog(
      "IMPORT_ROWS_VERIFIED",
      actor.id,
      `Verified ${res.count} row(s) in import batch ${id}`,
    );
    return NextResponse.json({ verified: res.count });
  } catch (err) {
    return travelError(err, "[API /travel/imports/[id]/verify]");
  }
}
