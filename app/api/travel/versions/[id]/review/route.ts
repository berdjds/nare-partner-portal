import { NextRequest, NextResponse } from "next/server";
import { review, reviewSchema } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const result = await review(actor, id, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    return travelError(err, "[API /travel/versions/[id]/review]");
  }
}
