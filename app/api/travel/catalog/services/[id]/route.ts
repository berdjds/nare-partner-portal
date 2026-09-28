import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../../guard";
import {
  durationVariantField,
  pricingBasisField,
  serviceCategoryField,
  serviceDetailsField,
  toWeekdaysJson,
  weekdaysField,
} from "../../schemas";

const patchServiceSchema = z
  .object({
    name: z.string().trim().min(1),
    details: serviceDetailsField,
    category: serviceCategoryField,
    basis: pricingBasisField,
    capacity: z.number().int().positive().nullish(),
    language: z.string().trim().min(1).nullish(),
    durationVariant: durationVariantField.nullish(),
    weekdays: weekdaysField,
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
  const parsed = patchServiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  const { weekdays, supplierId, ...rest } = parsed.data;

  try {
    const existing = await prisma.serviceProduct.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (supplierId) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) return NextResponse.json({ error: "Unknown supplierId" }, { status: 400 });
    }

    const service = await prisma.serviceProduct.update({
      where: { id },
      data: {
        ...rest,
        // undefined = unchanged; ""/whitespace clears the description.
        ...(rest.details !== undefined ? { details: rest.details?.trim() ? rest.details.trim() : null } : {}),
        ...(supplierId !== undefined ? { supplierId } : {}),
        ...(weekdays !== undefined ? { weekdays: toWeekdaysJson(weekdays) ?? null } : {}),
      },
    });
    await writeAuditLog("SERVICE_UPDATED", actor.id, `Updated service ${service.name} (${service.id})`);
    return NextResponse.json(service);
  } catch (err) {
    return travelError(err, "[API /travel/catalog/services/[id]]");
  }
}

// Hard delete of a service product AND its rate versions (ADMIN). Blocked
// while any quote version's service line still links the catalog product —
// those lines resolve their rates from RateVersion via this FK.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const service = await prisma.serviceProduct.findUnique({ where: { id } });
    if (!service) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const lines = await prisma.serviceLine.count({ where: { serviceProductId: service.id } });
    if (lines > 0) {
      return NextResponse.json(
        { error: `Cannot delete ${service.name}: used by ${lines} itinerary service line(s)` },
        { status: 409 },
      );
    }

    const rates = await prisma.rateVersion.count({ where: { serviceProductId: service.id } });
    await prisma.$transaction([
      prisma.rateVersion.deleteMany({ where: { serviceProductId: service.id } }),
      prisma.serviceProduct.delete({ where: { id: service.id } }),
    ]);
    await writeAuditLog(
      "SERVICE_DELETED",
      actor.id,
      `Deleted service ${service.name} (${service.id}) with ${rates} rate version(s)`,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/catalog/services/[id] DELETE]");
  }
}
