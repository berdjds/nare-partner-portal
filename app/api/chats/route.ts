import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/access-policy";
import { accountPermissions } from "@/lib/permissions";
import { MARHABA_ACCOUNT_KEY } from "@/lib/whatsapp-accounts";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  // W3 (wa-multi): chats are listed per account (?account=<key>, default
  // marhaba) and require THAT account's view permission (whatsapp.inbox.view
  // for marhaba, whatsapp.nare.view for nare), resolved from the current DB
  // row on every request (no or deactivated session → 401, missing
  // permission → 403).
  const accountKey = new URL(req.url).searchParams.get("account") || MARHABA_ACCOUNT_KEY;
  const perms = accountPermissions(accountKey);
  if (!perms) {
    return NextResponse.json({ error: `Unknown WhatsApp account: ${accountKey}` }, { status: 400 });
  }
  const access = await requirePermission(session, perms.view);
  if (!access.allowed) return access.response;

  const chats = await prisma.chat.findMany({
    where: { accountId: accountKey },
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
        select: { body: true, timestamp: true, fromMe: true, type: true },
      },
    },
  });

  return NextResponse.json(chats);
}
