import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ROLE_ADMIN, ROLE_ADVISOR, ROLE_PARTNER, ROLE_VALIDATOR } from "@/lib/travel/contracts";
import { partnerRequestList } from "@/lib/travel/partner-view";
import { createRequest, createRequestSchema } from "@/lib/travel/workflow";
import { getTravelActor, getTravelOrPartnerActor, travelError, unauthorized } from "../guard";

// GET /api/travel/search?q=&status=&ownerId=&from=&to= — advisors see only
// their own requests; ADMIN/VALIDATOR see all; any other role (a user
// holding a validation assignment, v0.10.0) sees own + assigned requests.
export async function GET(req: NextRequest) {
  const actor = await getTravelOrPartnerActor();
  if (!actor) return unauthorized();

  const { searchParams } = new URL(req.url);
  if (actor.role === ROLE_PARTNER) {
    // Own agency only, client-safe fields only (lib/travel/partner-view.ts).
    try {
      return NextResponse.json(
        await partnerRequestList(actor.agencyId as string, {
          q: searchParams.get("q")?.trim() || undefined,
          status: searchParams.get("status")?.trim() || undefined,
        }),
      );
    } catch (err) {
      return travelError(err, "[API /travel/requests]");
    }
  }
  const q = searchParams.get("q")?.trim();
  const status = searchParams.get("status")?.trim();
  const ownerId = searchParams.get("ownerId")?.trim();
  const from = searchParams.get("from")?.trim();
  const to = searchParams.get("to")?.trim();

  const where: any = {};
  if (actor.role === ROLE_ADVISOR) where.ownerId = actor.id;
  else if (actor.role !== ROLE_ADMIN && actor.role !== ROLE_VALIDATOR) {
    where.AND = [
      { OR: [{ ownerId: actor.id }, { assignments: { some: { validatorId: actor.id, active: true } } }] },
    ];
  } else if (ownerId) where.ownerId = ownerId;
  if (status) where.status = status;
  if (from || to) {
    where.startDate = {};
    if (from) where.startDate.gte = from;
    if (to) where.startDate.lte = to;
  }
  if (q) {
    where.OR = [
      { packageCode: { contains: q } },
      { title: { contains: q } },
      { agency: { name: { contains: q } } },
      { agency: { shortCode: { contains: q } } },
    ];
  }

  try {
    const requests = await prisma.travelRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        agency: { select: { id: true, shortCode: true, name: true } },
        owner: { select: { id: true, email: true, name: true } },
        validator: { select: { id: true, email: true, name: true } },
        versions: {
          orderBy: { versionNo: "desc" },
          take: 1,
          select: { id: true, versionNo: true, status: true, createdAt: true },
        },
      },
    });
    return NextResponse.json(requests);
  } catch (err) {
    return travelError(err, "[API /travel/requests]");
  }
}

export async function POST(req: NextRequest) {
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== ROLE_ADMIN && actor.role !== ROLE_ADVISOR) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const result = await createRequest(actor, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/requests]");
  }
}
