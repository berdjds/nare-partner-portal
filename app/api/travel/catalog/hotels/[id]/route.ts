import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../guard";
import { hotelKindField } from "../../schemas";

const patchHotelSchema = z
  .object({
    name: z.string().trim().min(1),
    city: z.string().trim().min(1).nullish(),
    country: z.string().trim().min(2).max(3),
    stars: z.number().int().min(1).max(5).nullish(),
    kind: hotelKindField,
    roomType: z.string().trim().min(1).nullish(),
    capacityAdults: z.number().int().min(0),
    capacityChildren: z.number().int().min(0),
    capacityTotal: z.number().int().min(1),
    beds: z.string().trim().min(1).nullish(),
    extraBedAllowed: z.boolean(),
    cotAllowed: z.boolean(),
    boardOptions: z.array(z.string().trim().min(1)).nullish(),
    supplierId: z.string().nullish(),
    active: z.boolean(),
  })
  .partial();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchHotelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  const { boardOptions, supplierId, ...rest } = parsed.data;

  try {
    const existing = await prisma.hotelProduct.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) return NextResponse.json({ error: "Unknown supplierId" }, { status: 400 });
    }

    const hotel = await prisma.hotelProduct.update({
      where: { id },
      data: {
        ...rest,
        ...(supplierId !== undefined ? { supplierId } : {}),
        ...(boardOptions !== undefined
          ? { boardOptions: boardOptions?.length ? JSON.stringify(boardOptions) : null }
          : {}),
      },
    });
    await writeAuditLog("HOTEL_UPDATED", actor.id, `Updated hotel ${hotel.name} (${hotel.id})`);
    return NextResponse.json(hotel);
  } catch (err) {
    return travelError(err, "[API /travel/catalog/hotels/[id]]");
  }
}

// Hard delete of a hotel product AND its rate versions (ADMIN). Blocked while
// any itinerary stay still links the catalog product — stays freeze the hotel
// name for display but keep the FK for rate resolution, so deleting would
// orphan them.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const hotel = await prisma.hotelProduct.findUnique({ where: { id } });
    if (!hotel) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const stays = await prisma.staySegment.count({ where: { hotelProductId: hotel.id } });
    if (stays > 0) {
      return NextResponse.json(
        { error: `Cannot delete ${hotel.name}: used by ${stays} itinerary stay(s)` },
        { status: 409 },
      );
    }

    const rates = await prisma.rateVersion.count({ where: { hotelProductId: hotel.id } });
    await prisma.$transaction([
      prisma.rateVersion.deleteMany({ where: { hotelProductId: hotel.id } }),
      prisma.hotelProduct.delete({ where: { id: hotel.id } }),
    ]);
    await writeAuditLog(
      "HOTEL_DELETED",
      actor.id,
      `Deleted hotel ${hotel.name} (${hotel.id}) with ${rates} rate version(s)`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/catalog/hotels/[id] DELETE]");
  }
}
