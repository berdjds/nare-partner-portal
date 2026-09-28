import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ROLE_ADMIN } from "@/lib/travel/contracts";
import { sendQuoteDocument } from "@/lib/travel/whatsapp-docs";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const sendSchema = z.object({
  userIds: z.array(z.string().min(1)).max(50).optional(),
  groupJids: z.array(z.string().min(1)).max(10).optional(),
});

// POST /api/travel/documents/[id]/send — delivers the rendered PDF over
// WhatsApp. Allowed for the request owner, the assigned validator and ADMIN.
// INTERNAL documents are additionally restricted per recipient (admins /
// validators only) inside sendQuoteDocument.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = sendSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }
  if ((parsed.data.userIds?.length ?? 0) === 0 && (parsed.data.groupJids?.length ?? 0) === 0) {
    return NextResponse.json({ error: "at least one recipient (userIds or groupJids) is required" }, { status: 400 });
  }

  try {
    const doc = await prisma.quoteDocument.findUnique({
      where: { id },
      include: { version: { select: { requestId: true, request: { select: { ownerId: true } } } } },
    });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (actor.role !== ROLE_ADMIN && doc.version.request.ownerId !== actor.id) {
      const assignment = await prisma.validationAssignment.findFirst({
        where: { requestId: doc.version.requestId, active: true },
        select: { validatorId: true },
      });
      if (assignment?.validatorId !== actor.id) {
        // Same policy as the download route: existence is not disclosed.
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }

    const results = await sendQuoteDocument(id, parsed.data, actor.id);
    return NextResponse.json({ results });
  } catch (err) {
    return travelError(err, "[API /travel/documents/[id]/send]");
  }
}
