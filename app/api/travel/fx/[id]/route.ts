import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// Hard delete of an FX rate version (ADMIN). The last rate of a currency is
// protected — without it the engine cannot convert that currency to AMD.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const fx = await prisma.fXRateVersion.findUnique({ where: { id } });
    if (!fx) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const siblings = await prisma.fXRateVersion.count({ where: { currency: fx.currency } });
    if (siblings <= 1) {
      return NextResponse.json(
        { error: `Cannot delete the last rate for ${fx.currency}` },
        { status: 409 },
      );
    }

    await prisma.fXRateVersion.delete({ where: { id: fx.id } });
    await writeAuditLog(
      "TRAVEL_FX_DELETED",
      actor.id,
      `Deleted FX ${fx.currency} = ${fx.amdPerUnit} AMD effective ${fx.effectiveFrom}`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/fx/[id] DELETE]");
  }
}
