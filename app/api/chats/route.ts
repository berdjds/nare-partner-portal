import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requireInboxAccess } from "@/lib/access-policy";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  // Interim W1 policy: chat inbox is ADMIN/USER only (ADVISOR/VALIDATOR → 403,
  // no or deactivated session → 401), decided from the current DB role.
  const access = await requireInboxAccess(session);
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
