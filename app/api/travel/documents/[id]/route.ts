import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";
import { writeAuditLog } from "@/lib/audit";
import { ROLE_ADMIN, ROLE_PARTNER, ROLE_VALIDATOR } from "@/lib/travel/contracts";
import { canDownloadInternalFor } from "@/lib/travel/internal-access";
import { getTravelOrPartnerActor, travelError, unauthorized } from "../../guard";

// Streams a quotation PDF. Every attempt (allowed or denied) is audit-logged
// as "travel.export" (actor, document, kind, outcome; never the file path).
//
// INTERNAL (costing sheet): D3 — travel.internal.download AND (ADMIN or an
// ACTIVE assignment to this request). A validator without that assignment is
// refused even though the preset carries the key. PARTNER never.
// CLIENT: travel.client_docs.download first. PARTNER: only an ISSUED document
// of a request of their own agency (anything else is 404 — existence is not
// disclosed). Staff: request owner, the assigned validator or ADMIN (404
// otherwise). The filesystem path is never exposed.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelOrPartnerActor();
  if (!actor) return unauthorized();

  let kind: string | null = null;
  let requestId: string | null = null;
  const audit = (outcome: "allowed" | "denied", reason?: string) =>
    writeAuditLog(
      "travel.export",
      actor.id,
      JSON.stringify({ documentId: id, kind, requestId, actorId: actor.id, actorRole: actor.role, outcome, ...(reason ? { reason } : {}) }),
    );
  const deny = async (status: 403 | 404, reason: string) => {
    await audit("denied", reason);
    return NextResponse.json({ error: status === 403 ? "Forbidden" : "Not found" }, { status });
  };

  try {
    const doc = await prisma.quoteDocument.findUnique({
      where: { id },
      include: { version: { select: { requestId: true, request: { select: { ownerId: true, agencyId: true } } } } },
    });
    if (!doc) return deny(404, "not_found");
    kind = doc.kind;
    requestId = doc.version.requestId;

    const assignedHere = async () =>
      (await prisma.validationAssignment.findFirst({
        where: { requestId: doc.version.requestId, validatorId: actor.id, active: true },
        select: { id: true },
      })) !== null;

    if (doc.kind === "INTERNAL") {
      if (actor.role === ROLE_PARTNER) return deny(403, "partner");
      if (!(await canDownloadInternalFor(actor, doc.version.requestId))) return deny(403, "internal_permission");
      if (actor.role !== ROLE_ADMIN && !(await assignedHere())) return deny(403, "not_assigned");
    } else {
      if (!hasPermission(actor, "travel.client_docs.download")) return deny(403, "client_permission");
      if (actor.role === ROLE_PARTNER) {
        if (doc.version.request.agencyId !== actor.agencyId || !doc.issuedAt) return deny(404, "partner_scope");
      } else if (actor.role !== ROLE_ADMIN) {
        const isOwner = doc.version.request.ownerId === actor.id;
        const isAssignedValidator = actor.role === ROLE_VALIDATOR && (await assignedHere());
        if (!isOwner && !isAssignedValidator) return deny(404, "not_owner_or_assigned");
      }
    }

    if (doc.filePath === "PENDING" || doc.filePath.startsWith("FAILED:")) {
      return deny(404, "not_rendered");
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(doc.filePath);
    } catch {
      return deny(404, "file_missing");
    }

    await audit("allowed");
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
