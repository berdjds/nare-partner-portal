/**
 * Single partner application for staff review (W5b, session + partners.review
 * required).
 *
 * GET /api/admin/partners/[id] — the full application row plus its document
 * metadata (id, kind, originalName, mime, size, sha256, createdAt). The
 * document storagePath is deliberately NOT selected: filesystem paths stay
 * private and downloads go through the documents/[docId] endpoint instead.
 * 404 for an unknown id — nothing about the request reveals internals.
 *
 * DELETE /api/admin/partners/[id] — removes the application's KYC documents
 * (the storage directory AND the PartnerDocument rows via
 * deleteKycDocuments()); the application row itself is kept. Writes a
 * PARTNER_KYC_DOCUMENTS_DELETED audit entry and answers with the deletion
 * counts. 404 for an unknown id.
 *
 * Both actions go through requirePartnerReviewer() (401 without an active
 * session, 403 without the partners.review permission).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { deleteKycDocuments } from "@/lib/partners/kyc-storage";
import { requirePartnerReviewer } from "@/lib/partners/review";

const LOG_PREFIX = "[API /admin/partners/[id]]";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const decision = await requirePartnerReviewer();
  if (!decision.allowed) return decision.response;

  const { id } = await params;

  try {
    const application = await prisma.partnerApplication.findUnique({
      where: { id },
      include: {
        documents: {
          select: {
            id: true,
            kind: true,
            originalName: true,
            mime: true,
            size: true,
            sha256: true,
            createdAt: true,
          },
        },
      },
    });
    if (!application) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(application);
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to load application:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to load application" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const decision = await requirePartnerReviewer();
  if (!decision.allowed) return decision.response;

  const { id } = await params;

  try {
    const application = await prisma.partnerApplication.findUnique({
      where: { id },
      select: { id: true, reference: true },
    });
    if (!application) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { deletedFiles, deletedRows } = await deleteKycDocuments(application.id);

    await writeAuditLog(
      "PARTNER_KYC_DOCUMENTS_DELETED",
      decision.user.id,
      `${application.reference} (${deletedFiles} file(s), ${deletedRows} row(s))`,
    );

    return NextResponse.json({ deletedFiles, deletedRows });
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to delete documents:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to delete documents" }, { status: 500 });
  }
}
