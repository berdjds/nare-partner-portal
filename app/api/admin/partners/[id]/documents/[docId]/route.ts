/**
 * KYC document download for staff review (W5b, session + partners.review
 * required).
 *
 * GET /api/admin/partners/[id]/documents/[docId] — streams one document of
 * one application through openKycReadStream() (the storage path is
 * re-validated to stay inside the KYC base directory there). The document is
 * looked up scoped to the application id: a document belonging to another
 * application answers 404 like a missing one — existence across applications
 * is not disclosed, and neither is the storage path itself. A filesystem
 * stat runs before streaming so an absent file answers 404 instead of a
 * broken stream. Each successful download writes a
 * PARTNER_KYC_DOCUMENT_DOWNLOADED audit entry.
 *
 * The response is an attachment: Content-Type from the stored mime (decided
 * server-side at upload from magic bytes), the original filename encoded for
 * RFC 5987 with an ASCII-safe fallback, nosniff, private/no-store caching,
 * and the stored sha256 for integrity verification by the reviewer.
 */

import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { openKycReadStream } from "@/lib/partners/kyc-storage";
import { requirePartnerReviewer } from "@/lib/partners/review";

const LOG_PREFIX = "[API /admin/partners/documents]";

/**
 * RFC 2616 quoted-string fallback for Content-Disposition: anything outside
 * printable ASCII, plus the quoting characters themselves, becomes "_". The
 * full filename (including non-ASCII) travels in filename*= instead.
 */
function asciiSafeFileName(originalName: string): string {
  const safe = originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return safe.length > 0 ? safe : "document";
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const decision = await requirePartnerReviewer();
  if (!decision.allowed) return decision.response;

  const { id, docId } = await params;

  try {
    const doc = await prisma.partnerDocument.findFirst({
      where: { id: docId, applicationId: id },
      include: { application: { select: { reference: true } } },
    });
    if (!doc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    try {
      await stat(doc.storagePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return NextResponse.json({ error: "Document file is missing" }, { status: 404 });
      }
      throw error;
    }

    await writeAuditLog(
      "PARTNER_KYC_DOCUMENT_DOWNLOADED",
      decision.user.id,
      `${doc.application.reference} document ${doc.id} "${doc.originalName}" (${doc.size} bytes)`,
    );

    // Node/web stream types differ from the DOM ReadableStream type; the
    // runtime accepts the converted stream, hence the double cast.
    const webStream = Readable.toWeb(openKycReadStream(doc.storagePath)) as unknown as ReadableStream;

    return new NextResponse(webStream, {
      headers: {
        "Content-Type": doc.mime,
        "Content-Disposition": `attachment; filename="${asciiSafeFileName(doc.originalName)}"; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "X-Content-SHA256": doc.sha256,
      },
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to download document:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to download document" }, { status: 500 });
  }
}
