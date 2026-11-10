import { canViewInternal, redactRate } from "@/lib/travel/redact";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";
import {
  currencyField,
  dateField,
  moneyField,
  occupancyField,
  productTypeField,
  toAmount,
  toWeekdaysJson,
  validityOrdered,
  weekdaysField,
} from "../schemas";

const createRateSchema = z
  .object({
    productType: productTypeField,
    hotelProductId: z.string().nullish(),
    vehicleTypeId: z.string().nullish(),
    serviceProductId: z.string().nullish(),
    amount: moneyField,
    currency: currencyField.default("AMD"),
    occupancy: occupancyField.nullish(),
    board: z.string().trim().min(1).nullish(),
    validFrom: dateField,
    validTo: dateField,
    weekdays: weekdaysField,
    minStay: z.number().int().positive().nullish(),
    priority: z.number().int().default(0),
    notes: z.string().trim().min(1).nullish(),
  })
  .refine(
    (d) =>
      (d.productType === "HOTEL" && !!d.hotelProductId && !d.vehicleTypeId && !d.serviceProductId) ||
      (d.productType === "VEHICLE" && !!d.vehicleTypeId && !d.hotelProductId && !d.serviceProductId) ||
      // SERVICE rates may optionally be scoped to a vehicle type (per-vehicle
      // transportation pricing); vehicleTypeId then identifies the bracket.
      (d.productType === "SERVICE" && !!d.serviceProductId && !d.hotelProductId),
    { message: "exactly one product reference matching productType is required" },
  )
  .refine((d) => validityOrdered(d.validFrom, d.validTo), {
    message: "validFrom must be before validTo",
    path: ["validTo"],
  });

// Rate browsing with filters; includes NEEDS_REVIEW so validators can verify.
export async function GET(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status")?.trim();
  const productType = searchParams.get("productType")?.trim();
  const hotelProductId = searchParams.get("hotelProductId")?.trim();

  try {
    const rates = await prisma.rateVersion.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(productType ? { productType } : {}),
        ...(hotelProductId ? { hotelProductId } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        hotelProduct: { select: { id: true, name: true, city: true } },
        vehicleType: { select: { id: true, name: true } },
        serviceProduct: { select: { id: true, name: true } },
      },
      take: 500,
    });
    return NextResponse.json(canViewInternal(actor) ? rates : rates.map(redactRate));
  } catch (err) {
    return travelError(err, "[API /travel/catalog/rates]");
  }
}

// Manually entered rates always start as NEEDS_REVIEW — validators verify them
// on the Rates tab. Status is never accepted on create.
export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createRateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  const { weekdays, amount, ...rest } = parsed.data;

  try {
    const productExists =
      (rest.productType === "HOTEL" &&
        (await prisma.hotelProduct.findUnique({ where: { id: rest.hotelProductId! } }))) ||
      (rest.productType === "VEHICLE" &&
        (await prisma.vehicleType.findUnique({ where: { id: rest.vehicleTypeId! } }))) ||
      (rest.productType === "SERVICE" &&
        (await prisma.serviceProduct.findUnique({ where: { id: rest.serviceProductId! } })));
    if (!productExists) {
      return NextResponse.json({ error: "Unknown product for productType" }, { status: 400 });
    }
    if (rest.productType === "SERVICE" && rest.vehicleTypeId) {
      const vehicle = await prisma.vehicleType.findUnique({ where: { id: rest.vehicleTypeId } });
      if (!vehicle) {
        return NextResponse.json({ error: "Unknown vehicle type" }, { status: 400 });
      }
    }

    const rate = await prisma.rateVersion.create({
      data: {
        ...rest,
        hotelProductId: rest.hotelProductId ?? null,
        vehicleTypeId: rest.vehicleTypeId ?? null,
        serviceProductId: rest.serviceProductId ?? null,
        amount: toAmount(amount) ?? null,
        weekdays: toWeekdaysJson(weekdays) ?? null,
        status: "NEEDS_REVIEW",
        createdById: actor.id,
      },
    });
    await writeAuditLog(
      "RATE_CREATED",
      actor.id,
      `Created ${rate.productType} rate ${rate.id} (${rate.amount ?? "TBC"} ${rate.currency})`,
    );
    return NextResponse.json(rate, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/catalog/rates]");
  }
}
