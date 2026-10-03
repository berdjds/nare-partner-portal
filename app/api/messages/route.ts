import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/access-policy";
import { accountPermissions } from "@/lib/permissions";
import { MARHABA_ACCOUNT_KEY } from "@/lib/whatsapp-accounts";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const { searchParams } = new URL(req.url);
  // W3 (wa-multi): messages are read per account (?account=<key>, default
  // marhaba) and require THAT account's view permission, resolved from the
  // current DB row.
  const accountKey = searchParams.get("account") || MARHABA_ACCOUNT_KEY;
  const perms = accountPermissions(accountKey);
  if (!perms) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }
  const access = await requirePermission(session, perms.view);
  if (!access.allowed) return access.response;

  const chatId = searchParams.get("chatId");
  const remoteJid = searchParams.get("remoteJid");

  if (!chatId && !remoteJid) {
    return NextResponse.json({ error: "chatId or remoteJid required" }, { status: 400 });
  }

  const where: any = { accountId: accountKey };
  if (chatId) where.chatId = chatId;
  else where.remoteJid = remoteJid;

  const messages = await prisma.message.findMany({
    where,
    orderBy: { timestamp: "asc" },
  });

  return NextResponse.json(messages);
}
