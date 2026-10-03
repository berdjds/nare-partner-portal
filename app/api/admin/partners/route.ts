/**
 * Staff partner application queue (W5b, session + partners.review required).
 *
 * GET /api/admin/partners — lists applications for the review queue. Every
 * request goes through requirePartnerReviewer() (401 without an active
 * session, 403 without the partners.review permission). Optional query
 * params: `status` (must be one of the application statuses, else 400) and
 * `search` (case-insensitive substring over the reference, company, trading,
 * contact name and contact email fields; trimmed, empty ignored, capped at
 * 200 chars). Newest first; the response is a bare array with a deliberately
 * narrow column set — documents, IP hashes and storage details are only
 * available through the per-application endpoints.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PARTNER_APPLICATION_STATUSES, requirePartnerReviewer } from "@/lib/partners/review";

const LOG_PREFIX = "[API /admin/partners]";

const MAX_SEARCH_LENGTH = 200;

export async function GET(req: NextRequest) {
  const decision = await requirePartnerReviewer();
  if (!decision.allowed) return decision.response;

  const searchParams = new URL(req.url).searchParams;

  const statusParam = searchParams.get("status");
  if (statusParam !== null && !(PARTNER_APPLICATION_STATUSES as readonly string[]).includes(statusParam)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  const search = (searchParams.get("search") ?? "").trim().slice(0, MAX_SEARCH_LENGTH);

  const where: Prisma.PartnerApplicationWhereInput = {};
  if (statusParam !== null) where.status = statusParam;
  if (search !== "") {
    where.OR = [
      { reference: { contains: search } },
      { companyLegalName: { contains: search } },
      { tradingName: { contains: search } },
      { contactName: { contains: search } },
      { contactEmail: { contains: search } },
    ];
  }

  try {
    const applications = await prisma.partnerApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        reference: true,
        status: true,
        companyLegalName: true,
        tradingName: true,
        country: true,
        city: true,
        contactName: true,
        contactEmail: true,
        licenceExpiry: true,
        createdAt: true,
        reviewedAt: true,
      },
    });
    return NextResponse.json(applications);
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to list applications:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to list applications" }, { status: 500 });
  }
}
