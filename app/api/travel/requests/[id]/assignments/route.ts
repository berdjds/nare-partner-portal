import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assignValidator, assignValidatorSchema } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

// Assignment history (newest first).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const assignments = await prisma.validationAssignment.findMany({
      where: { requestId: id },
      orderBy: { createdAt: "desc" },
      include: { validator: { select: { id: true, email: true, name: true, role: true } } },
    });
    return NextResponse.json(assignments);
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/assignments]");
  }
}

// Initial assignment: ADMIN, or the owning advisor assigning someone else.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = assignValidatorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const assignment = await assignValidator(actor, id, parsed.data);
    return NextResponse.json(assignment, { status: 201 });
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/assignments]");
  }
}
