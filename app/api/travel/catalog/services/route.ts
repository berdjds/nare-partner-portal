import { canViewInternal, redactCatalogRates } from "@/lib/travel/redact";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";
import {
  durationVariantField,
  pricingBasisField,
  serviceCategoryField,
  serviceDetailsField,
  toWeekdaysJson,
  weekdaysField,
} from "../schemas";

const createServiceSchema = z.object({
  name: z.string().trim().min(1),
  details: serviceDetailsField,
  category: serviceCategoryField,
  basis: pricingBasisField,
  capacity: z.number().int().positive().nullish(),
  language: z.string().trim().min(1).nullish(),
  durationVariant: durationVariantField.nullish(),
  weekdays: weekdaysField,
  supplierId: z.string().nullish(),
  active: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const category = searchParams.get("category")?.trim();
  const includeInactive = searchParams.get("includeInactive") === "true";

  try {
    const services = await prisma.serviceProduct.findMany({
      where: {
        ...(includeInactive ? {} : { active: true }),
        ...(q ? { name: { contains: q } } : {}),
        ...(category ? { category } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: {
        supplier: { select: { id: true, name: true } },
        rates: {
          where: { status: { not: "ARCHIVED" } },
          include: { vehicleType: { select: { id: true, name: true } } },
        },
      },
    });
    return NextResponse.json(canViewInternal(actor) ? services : services.map(redactCatalogRates));
  } catch (err) {
    return travelError(err, "[API /travel/catalog/services]");
  }
}

export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  const { weekdays, supplierId, ...rest } = parsed.data;

  try {
    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) return NextResponse.json({ error: "Unknown supplierId" }, { status: 400 });
    }
    const service = await prisma.serviceProduct.create({
      data: {
        ...rest,
        details: rest.details?.trim() ? rest.details.trim() : null,
        supplierId: supplierId ?? null,
        weekdays: toWeekdaysJson(weekdays) ?? null,
      },
    });
    await writeAuditLog("SERVICE_CREATED", actor.id, `Created service ${service.name} (${service.id})`);
    return NextResponse.json(service, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/catalog/services]");
  }
}
