import { NextRequest, NextResponse } from "next/server";
import { assignValidatorSchema, reassign } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = assignValidatorSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const assignment = await reassign(actor, id, parsed.data);
    return NextResponse.json(assignment);
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/reassign]");
  }
}
