import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { sendWhatsAppMessage, getWhatsAppState } from "@/lib/whatsapp";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/access-policy";
import { accountPermissions } from "@/lib/permissions";
import { MARHABA_ACCOUNT_KEY } from "@/lib/whatsapp-accounts";
import { z } from "zod";

const sendSchema = z.object({
  account: z.string().optional(),
  remoteJid: z.string().min(1),
  body: z.string().optional(),
  type: z.enum(["text", "image", "voice", "document"]).default("text"),
  mediaBase64: z.string().optional(),
  mediaMimeType: z.string().optional(),
  mediaFilename: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const body = await req.json();
  console.log("[API /send] request body:", body);
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    console.log("[API /send] validation failed:", parsed.error.errors);
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  // W3 (wa-multi): the send goes through ONE account (body.account, default
  // marhaba) and requires THAT account's send permission (whatsapp.inbox.send
  // / whatsapp.nare.send), resolved from the current DB row (deactivated
  // users get 401 like anonymous).
  const accountKey = parsed.data.account || MARHABA_ACCOUNT_KEY;
  const perms = accountPermissions(accountKey);
  if (!perms) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }
  const access = await requirePermission(session, perms.send);
  if (!access.allowed) return access.response;

  if (getWhatsAppState(accountKey).state !== "ready") {
    console.log("[API /send] rejected: WhatsApp account not ready", accountKey);
    return NextResponse.json({ error: `WhatsApp account "${accountKey}" not ready` }, { status: 503 });
  }

  try {
    const result = await sendWhatsAppMessage({ ...parsed.data, accountKey });
    console.log("[API /send] sendWhatsAppMessage result:", result);

    await writeAuditLog(
      "SEND_MESSAGE",
      access.user.id,
      `[${accountKey}] Sent ${parsed.data.type} to ${parsed.data.remoteJid}`
    );

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to send message" }, { status: 500 });
  }
}
