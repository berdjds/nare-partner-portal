import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { ROLE_ADMIN, ROLE_VALIDATOR } from "@/lib/travel/contracts";
import { getTravelActor, travelError, unauthorized } from "../../guard";

// Streams a quotation PDF. W2 (perm-travel): the kind's permission key is
// required first — CLIENT needs travel.client_docs.download, INTERNAL needs
// travel.internal.download (D2: admin-only preset, so non-admins need an
// explicit grant). The pre-W2 record rules stay as the minimum on top:
// CLIENT documents: request owner, the currently assigned validator or ADMIN
// (others get 404 — existence is not disclosed); INTERNAL: ADMIN/VALIDATOR
// roles, plus the assigned validator of any role (the assignment itself
// grants internal visibility, v0.10.0). The filesystem path is never exposed.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const doc = await prisma.quoteDocument.findUnique({
      where: { id },
      include: { version: { select: { requestId: true, request: { select: { ownerId: true } } } } },
    });
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (doc.kind === "INTERNAL") {
      if (!hasPermission(actor, "travel.internal.download")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      let allowed = actor.role === ROLE_ADMIN || actor.role === ROLE_VALIDATOR;
      if (!allowed) {
        const assignment = await prisma.validationAssignment.findFirst({
          where: { requestId: doc.version.requestId, active: true },
          select: { validatorId: true },
        });
        allowed = assignment?.validatorId === actor.id;
      }
      if (!allowed) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } else {
      if (!hasPermission(actor, "travel.client_docs.download")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (actor.role !== ROLE_ADMIN) {
        const isOwner = doc.version.request.ownerId === actor.id;
        let isAssignedValidator = false;
        if (actor.role === ROLE_VALIDATOR) {
          const assignment = await prisma.validationAssignment.findFirst({
            where: { requestId: doc.version.requestId, active: true },
            select: { validatorId: true },
          });
          isAssignedValidator = assignment?.validatorId === actor.id;
        }
        if (!isOwner && !isAssignedValidator) {
          return NextResponse.json({ error: "Not found" }, { status: 404 });
        }
      }
    }

    if (doc.filePath === "PENDING" || doc.filePath.startsWith("FAILED:")) {
      return NextResponse.json({ error: "Document is not rendered yet" }, { status: 404 });
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(doc.filePath);
    } catch {
      return NextResponse.json({ error: "Document file is missing" }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${doc.id}.pdf"`,
        "X-Content-SHA256": doc.sha256,
      },
    });
  } catch (err) {
    return travelError(err, "[API /travel/documents/[id]]");
  }
}
