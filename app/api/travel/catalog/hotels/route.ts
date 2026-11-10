import { canViewInternal, redactCatalogRates } from "@/lib/travel/redact";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";
import { hotelKindField } from "../schemas";

const boardOptionsField = z.array(z.string().trim().min(1)).nullish();

const createHotelSchema = z.object({
  name: z.string().trim().min(1),
  city: z.string().trim().min(1).nullish(),
  country: z.string().trim().min(2).max(3).default("AM"),
  stars: z.number().int().min(1).max(5).nullish(),
  kind: hotelKindField.default("ROOM"),
  roomType: z.string().trim().min(1).nullish(),
  capacityAdults: z.number().int().min(0).optional(),
  capacityChildren: z.number().int().min(0).optional(),
  capacityTotal: z.number().int().min(1).optional(),
  beds: z.string().trim().min(1).nullish(),
  extraBedAllowed: z.boolean().optional(),
  cotAllowed: z.boolean().optional(),
  boardOptions: boardOptionsField,
  supplierId: z.string().nullish(),
  active: z.boolean().optional(),
});

// Hotel products with their non-archived rates (catalog browsing).
export async function GET(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const includeInactive = searchParams.get("includeInactive") === "true";

  try {
    const hotels = await prisma.hotelProduct.findMany({
      where: {
        ...(includeInactive ? {} : { active: true }),
        ...(q ? { OR: [{ name: { contains: q } }, { city: { contains: q } }] } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        supplier: { select: { id: true, name: true } },
        rates: {
          where: { status: { not: "ARCHIVED" } },
          orderBy: [{ occupancy: "asc" }, { validFrom: "asc" }],
        },
      },
    });
    return NextResponse.json(canViewInternal(actor) ? hotels : hotels.map(redactCatalogRates));
  } catch (err) {
    return travelError(err, "[API /travel/catalog/hotels]");
  }
}

export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createHotelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  const { boardOptions, supplierId, ...rest } = parsed.data;

  try {
    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) return NextResponse.json({ error: "Unknown supplierId" }, { status: 400 });
    }
    const hotel = await prisma.hotelProduct.create({
      data: {
        ...rest,
        supplierId: supplierId ?? null,
        boardOptions: boardOptions?.length ? JSON.stringify(boardOptions) : null,
      },
    });
    await writeAuditLog("HOTEL_CREATED", actor.id, `Created hotel ${hotel.name} (${hotel.id})`);
    return NextResponse.json(hotel, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/catalog/hotels]");
  }
}
