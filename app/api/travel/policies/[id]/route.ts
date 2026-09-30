import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// Hard delete of a pricing policy version (ADMIN). Guarded: the engine always
// needs at least one policy, and deleting the ACTIVE one would leave quotes
// without pricing rules — activate another version first.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const policy = await prisma.pricingPolicyVersion.findUnique({ where: { id } });
    if (!policy) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const total = await prisma.pricingPolicyVersion.count();
    if (total <= 1) {
      return NextResponse.json({ error: "At least one pricing policy must remain" }, { status: 409 });
    }
    if (policy.active) {
      return NextResponse.json(
        { error: "Activate another policy before deleting this one" },
        { status: 409 },
      );
    }

    await prisma.$transaction([
      prisma.pricingPolicyVersion.delete({ where: { id: policy.id } }),
      // TravelSettings.defaultPolicyId is a plain string (no FK) — clear a
      // stale pointer if it referenced the deleted version.
      prisma.travelSettings.updateMany({
        where: { defaultPolicyId: policy.id },
        data: { defaultPolicyId: null },
      }),
    ]);
    await writeAuditLog("TRAVEL_POLICY_DELETED", actor.id, `Deleted policy ${policy.name} (${policy.id})`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/policies/[id] DELETE]");
  }
}
