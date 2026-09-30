import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { ROLE_ADMIN } from "@/lib/travel/contracts";
import { sendQuoteDocument } from "@/lib/travel/whatsapp-docs";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const sendSchema = z.object({
  userIds: z.array(z.string().min(1)).max(50).optional(),
  groupJids: z.array(z.string().min(1)).max(10).optional(),
});

// POST /api/travel/documents/[id]/send — delivers the rendered PDF over
// WhatsApp. W2 (perm-travel): sending a CLIENT document requires the
// travel.client_docs.send permission — deliberately separate from
// whatsapp.inbox.send so a travel-only user can send a client quotation
// without inbox access. The pre-W2 record rule stays as the minimum on top:
// request owner, the assigned validator and ADMIN; anyone else gets 404 so
// existence is not disclosed. int-lock: INTERNAL documents are never sent
// via WhatsApp — every otherwise-authorized actor (ADMIN included) gets 403,
// and sendQuoteDocument refuses them too, so no code path can bypass it.
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

    if (doc.kind === "CLIENT" && !hasPermission(actor, "travel.client_docs.send")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    // int-lock comes after the record rule so strangers still get 404 instead
    // of learning the document exists and is INTERNAL.
    if (doc.kind === "INTERNAL") {
      return NextResponse.json({ error: "INTERNAL documents cannot be sent via WhatsApp" }, { status: 403 });
    }

    const results = await sendQuoteDocument(id, parsed.data, actor.id);
    return NextResponse.json({ results });
  } catch (err) {
    return travelError(err, "[API /travel/documents/[id]/send]");
  }
}
