/**
 * WhatsApp delivery of rendered quotation PDFs.
 *
 * Shared by the manual send endpoint (app/api/travel/documents/[id]/send) and
 * the best-effort auto-send after issue() in workflow.ts. Delivery failures
 * are reported per recipient and never thrown — document generation and
 * workflow transitions must not depend on WhatsApp being connected.
 *
 * int-lock: INTERNAL costing sheets are never delivered, to anyone, through
 * any caller — the refusal lives here so no code path can bypass it.
 */

import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { resolveTravelAccount } from "@/lib/whatsapp-accounts";
import { versionLabel } from "@/lib/travel/contracts";

export interface DocumentSendResult {
  to: string;
  ok: boolean;
  error?: string;
}

/**
 * Sends the rendered PDF of a QuoteDocument to users (by id, resolved to
 * their WhatsApp phone) and/or WhatsApp groups (by @g.us jid).
 *
 * int-lock: INTERNAL documents carry margins and are never sent via
 * WhatsApp — every requested target gets a failure entry and the refusal is
 * audited. This holds for already-generated documents too: the kind check
 * runs at send time on the loaded document.
 */
export async function sendQuoteDocument(
  documentId: string,
  targets: { userIds?: string[]; groupJids?: string[] },
  actorId: string | null,
): Promise<DocumentSendResult[]> {
  const doc = await prisma.quoteDocument.findUnique({
    where: { id: documentId },
    include: {
      version: {
        select: {
          versionNo: true,
          request: { select: { packageCode: true } },
        },
      },
    },
  });
  if (!doc) return [{ to: documentId, ok: false, error: "document not found" }];

  const caption = `${doc.version.request.packageCode} ${versionLabel(doc.version.versionNo)} ${doc.kind}`;
  const filename = `${doc.version.request.packageCode}-${versionLabel(doc.version.versionNo)}-${doc.kind}.pdf`;

  if (doc.kind === "INTERNAL") {
    const error = "INTERNAL documents cannot be sent via WhatsApp";
    const refused: DocumentSendResult[] = [
      ...(targets.userIds ?? []).map((id) => ({ to: id, ok: false, error })),
      ...(targets.groupJids ?? []).map((jid) => ({ to: jid, ok: false, error })),
    ];
    await writeAuditLog(
      "QUOTE_DOCUMENT_SEND_REFUSED",
      actorId,
      `${caption} (${documentId}): WhatsApp delivery refused for ${refused.length} recipient(s) — ${error}`,
    );
    return refused;
  }

  let mediaBase64: string | null = null;
  let loadError: string | null = null;
  if (doc.filePath === "PENDING" || doc.filePath.startsWith("FAILED:")) {
    loadError = "document is not rendered yet";
  } else {
    try {
      mediaBase64 = (await readFile(doc.filePath)).toString("base64");
    } catch {
      loadError = "document file is missing";
    }
  }

  const results: DocumentSendResult[] = [];

  // W3 (travel-nare): all travel-module sends go through the account named by
  // TravelSettings.whatsappAccountKey (default 'nare') — never Marhaba. A
  // misconfigured key or a disabled account fails every recipient with a
  // coded, actionable WorkflowError naming the account (reported, never
  // thrown, like every other delivery failure); the send can be retried later
  // on the SAME account. Dynamic import: workflow.ts imports this module, so
  // a static import of WorkflowError would close a cycle.
  let accountKey: string | null = null;
  let accountError: string | null = null;
  try {
    const account = await resolveTravelAccount();
    if (!account.enabled) {
      const { WorkflowError } = await import("@/lib/travel/workflow");
      throw new WorkflowError(
        "TRAVEL_WHATSAPP_ACCOUNT_DISABLED",
        `Travel WhatsApp account "${account.key}" (${account.displayName}) is disabled. ` +
          `Enable it under Admin → WhatsApp accounts; the send can be retried on the same account.`,
        503,
      );
    }
    accountKey = account.key;
  } catch (err: any) {
    accountError = err?.code
      ? `${err.code}: ${err.message}`
      : `TRAVEL_WHATSAPP_ACCOUNT_NOT_CONFIGURED: ${err?.message ?? String(err)}`;
  }

  for (const userId of targets.userIds ?? []) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, phone: true, active: true },
    });
    const label = user ? user.name || user.email : userId;
    if (!user || !user.active) {
      results.push({ to: label, ok: false, error: "user not found or inactive" });
      continue;
    }
    if (!user.phone) {
      results.push({ to: label, ok: false, error: "no WhatsApp phone on file" });
      continue;
    }
    results.push(await deliver(user.phone, label));
  }

  for (const jid of targets.groupJids ?? []) {
    if (!jid.endsWith("@g.us")) {
      results.push({ to: jid, ok: false, error: "not a WhatsApp group id" });
      continue;
    }
    results.push(await deliver(jid, jid));
  }

  async function deliver(destination: string, label: string): Promise<DocumentSendResult> {
    if (loadError) return { to: label, ok: false, error: loadError };
    if (accountError || !accountKey) return { to: label, ok: false, error: accountError ?? "travel WhatsApp account not configured" };
    try {
      await sendWhatsAppMessage({
        accountKey,
        remoteJid: destination,
        body: caption,
        type: "document",
        mediaBase64: mediaBase64!,
        mediaMimeType: "application/pdf",
        mediaFilename: filename,
      });
      return { to: label, ok: true };
    } catch (err: any) {
      return { to: label, ok: false, error: err?.message ?? String(err) };
    }
  }

  await writeAuditLog(
    "QUOTE_DOCUMENT_SENT",
    actorId,
    `${caption}: ${results.filter((r) => r.ok).length} sent, ${results.filter((r) => !r.ok).length} failed` +
      (results.some((r) => !r.ok)
        ? ` — ${results.filter((r) => !r.ok).map((r) => `${r.to}: ${r.error}`).join("; ")}`
        : ""),
  );

  return results;
}
