import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { publicDocumentView } from "@/lib/travel/redact";
import { issue, issueSchema, retryDocument } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const issueBodySchema = issueSchema.extend({
  // retryDocumentId regenerates the PDF of an existing document (after a
  // FAILED render) without touching workflow state.
  retryDocumentId: z.string().max(200).optional(),
});

// Idempotent issuing: repeating with the same idempotencyKey (or the default
// `issue-<versionId>`) returns the existing document with 200. Documents are
// returned as public views — never with the filesystem path or render error.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const parsed = issueBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    if (parsed.data.retryDocumentId) {
      const document = await retryDocument(actor, parsed.data.retryDocumentId);
      return NextResponse.json({ document: publicDocumentView(document!), retried: true });
    }
    const { document, idempotent } = await issue(actor, id, parsed.data);
    return NextResponse.json({ document: publicDocumentView(document), idempotent }, { status: 200 });
  } catch (err) {
    return travelError(err, "[API /travel/versions/[id]/issue]");
  }
}
