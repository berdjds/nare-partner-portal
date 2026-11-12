import { canViewInternal, redactPolicy } from "@/lib/travel/redact";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { POLICY_TYPES } from "@/lib/travel/contracts";
import { getTravelActor, travelError, unauthorized } from "../guard";

const createPolicySchema = z.object({
  name: z.string().min(1),
  type: z.enum(POLICY_TYPES),
  rate: z.string().nullish(),
  minProfit: z.string().nullish(),
  minProfitCurrency: z.string().nullish(),
  feeFraction: z.string().nullish(),
  roundingIncrement: z.string().default("1"),
  quoteCurrency: z.string().default("USD"),
  allowBelowFloorException: z.boolean().default(false),
});

export async function GET() {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const policies = await prisma.pricingPolicyVersion.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(canViewInternal(actor) ? policies : policies.map(redactPolicy));
  } catch (err) {
    return travelError(err, "[API /travel/policies]");
  }
}

// Creates a new policy VERSION (inactive until activated via settings PUT).
export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createPolicySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const policy = await prisma.pricingPolicyVersion.create({
      data: { ...parsed.data, createdById: actor.id },
    });
    await writeAuditLog("TRAVEL_POLICY_CREATED", actor.id, `Created policy ${policy.name} (${policy.id})`);
    return NextResponse.json(policy, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/policies]");
  }
}
