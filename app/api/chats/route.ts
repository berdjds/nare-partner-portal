import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/access-policy";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  // W2 permission policy: the chat inbox requires the effective
  // whatsapp.inbox.view permission (no or deactivated session → 401, missing
  // permission → 403), resolved from the current DB row on every request.
  const access = await requirePermission(session, "whatsapp.inbox.view");
  if (!access.allowed) return access.response;

  const chats = await prisma.chat.findMany({
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
