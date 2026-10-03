/**
 * Review decision on a partner application (W5b, session + partners.review
 * required).
 *
 * POST /api/admin/partners/[id]/decision — one of three actions:
 *
 * - approve: resolves the Agency short code (explicit body.shortCode,
 *   trimmed/uppercased, or a proposal derived from the company legal name)
 *   and validates it against /^[A-Z]{3,10}$/ (400 otherwise). A taken code
 *   answers 409 — checked up front and again inside the transaction (the
 *   Agency.shortCode unique index turns the race into a P2002). One
 *   transaction then creates the Agency and marks the application APPROVED
 *   with the new agencyId, so a half-approved state is impossible. An
 *   already-APPROVED application answers 409 for every action — approval is
 *   terminal; a REJECTED or INFO_REQUESTED application can be re-decided.
 * - reject / request-info: require a non-empty decisionNote (400 otherwise),
 *   store it trimmed with the REJECTED / INFO_REQUESTED status.
 *
 * Every decision stamps reviewedById/reviewedAt, writes an audit entry
 * (PARTNER_APPLICATION_APPROVED / _REJECTED / _INFO_REQUESTED) and emails the
 * applicant; an email failure is logged and never fails the request — the
 * decision is already stored.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { PartnerApplication } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit";
import {
  proposeShortCode,
  requirePartnerReviewer,
  sendApplicantDecisionEmail,
  SHORT_CODE_PATTERN,
  type PartnerDecision,
} from "@/lib/partners/review";

const LOG_PREFIX = "[API /admin/partners/decision]";

const decisionSchema = z.object({
  action: z.enum(["approve", "reject", "request-info"]),
  shortCode: z.string().max(20).optional(),
  decisionNote: z.string().max(2000).optional(),
});

const DECISION_BY_ACTION = {
  approve: "APPROVED",
  reject: "REJECTED",
  "request-info": "INFO_REQUESTED",
} as const;

const AUDIT_ACTION_BY_DECISION: Record<PartnerDecision, string> = {
  APPROVED: "PARTNER_APPLICATION_APPROVED",
  REJECTED: "PARTNER_APPLICATION_REJECTED",
  INFO_REQUESTED: "PARTNER_APPLICATION_INFO_REQUESTED",
};

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2002";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requirePartnerReviewer();
  if (!access.allowed) return access.response;
  const user = access.user;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
  }
  const { action } = parsed.data;
  const decision: PartnerDecision = DECISION_BY_ACTION[action];

  let application: PartnerApplication | null;
  try {
    application = await prisma.partnerApplication.findUnique({ where: { id } });
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to load application:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to load application" }, { status: 500 });
  }
  if (!application) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Approval is terminal: re-approving would create a second Agency, and a
  // decided-as-approved partner must not be silently re-decided.
  if (application.status === "APPROVED") {
    return NextResponse.json({ error: "Application is already approved" }, { status: 409 });
  }

  const reviewedAt = new Date();

  if (action === "reject" || action === "request-info") {
    const note = (parsed.data.decisionNote ?? "").trim();
    if (note === "") {
      return NextResponse.json({ error: "decisionNote is required" }, { status: 400 });
    }

    let updated: PartnerApplication;
    try {
      updated = await prisma.partnerApplication.update({
        where: { id: application.id },
        data: { status: decision, decisionNote: note, reviewedById: user.id, reviewedAt },
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} failed to record decision:`, (error as Error)?.message ?? error);
      return NextResponse.json({ error: "Failed to record decision" }, { status: 500 });
    }

    await writeAuditLog(
      AUDIT_ACTION_BY_DECISION[decision],
      user.id,
      `${application.reference} ${application.companyLegalName} note="${note}"`,
    );
    await sendApplicantDecisionEmail({
      to: application.contactEmail,
      reference: application.reference,
      companyLegalName: application.companyLegalName,
      decision,
      decisionNote: note,
    });

    return NextResponse.json(updated);
  }

  // approve
  const shortCode =
    parsed.data.shortCode !== undefined
      ? parsed.data.shortCode.trim().toUpperCase()
      : proposeShortCode(application.companyLegalName);
  if (shortCode === null || !SHORT_CODE_PATTERN.test(shortCode)) {
    return NextResponse.json({ error: "shortCode must be 3-10 uppercase letters" }, { status: 400 });
  }

  const note = (parsed.data.decisionNote ?? "").trim() || null;

  try {
    const existing = await prisma.agency.findUnique({ where: { shortCode } });
    if (existing) {
      return NextResponse.json({ error: "shortCode is already in use" }, { status: 409 });
    }

    // One transaction: the Agency row and the application's APPROVED state
    // commit or roll back together, so there is never an approved application
    // without an agency (or an orphan agency).
    const { updated, agency } = await prisma.$transaction(async (tx) => {
      const agency = await tx.agency.create({
        data: {
          shortCode,
          name: application.companyLegalName,
          contactName: application.contactName,
          contactEmail: application.contactEmail,
          contactPhone: application.contactPhone,
        },
      });
      const updated = await tx.partnerApplication.update({
        where: { id: application.id },
        data: {
          status: "APPROVED",
          agencyId: agency.id,
          reviewedById: user.id,
          reviewedAt,
          decisionNote: note,
        },
      });
      return { updated, agency };
    });

    await writeAuditLog(
      "PARTNER_APPLICATION_APPROVED",
      user.id,
      `${application.reference} ${application.companyLegalName} shortCode=${shortCode}`,
    );
    await sendApplicantDecisionEmail({
      to: application.contactEmail,
      reference: application.reference,
      companyLegalName: application.companyLegalName,
      decision: "APPROVED",
      decisionNote: note,
    });

    return NextResponse.json({ application: updated, agency });
  } catch (error) {
    // The Agency.shortCode unique index closes the race between the pre-check
    // above and the create inside the transaction.
    if (isUniqueConflict(error)) {
      return NextResponse.json({ error: "shortCode is already in use" }, { status: 409 });
    }
    console.error(`${LOG_PREFIX} failed to approve application:`, (error as Error)?.message ?? error);
    return NextResponse.json({ error: "Failed to approve application" }, { status: 500 });
  }
}
