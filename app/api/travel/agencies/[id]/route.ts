import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";

const updateAgencySchema = z.object({
  shortCode: z.string().regex(/^[A-Z0-9]{2,12}$/).optional(),
  name: z.string().min(1).optional(),
  contactName: z.string().nullish(),
  contactEmail: z.string().email().nullish(),
  contactPhone: z.string().nullish(),
  active: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = updateAgencySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const agency = await prisma.agency.update({ where: { id }, data: parsed.data });
    await writeAuditLog("AGENCY_UPDATED", actor.id, `Updated agency ${agency.shortCode}`);
    return NextResponse.json(agency);
  } catch (err) {
    return travelError(err, "[API /travel/agencies/[id]]");
  }
}
