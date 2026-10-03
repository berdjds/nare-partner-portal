/**
 * Staff review helpers for partner applications (W5b).
 *
 * Shared by the /api/admin/partners/* routes: the requirePartnerReviewer()
 * gate (partners.review permission, decided by the effective permissions —
 * an ADMIN denied the key is out, a non-admin granted it is in), the status
 * vocabulary, short-code validation/proposal for approvals, and the
 * applicant decision email. The email wrapper NEVER throws into callers —
 * email must not fail a decision that is already safely stored; failures are
 * logged and reported as false instead. Wording leans on
 * lib/portal-content.ts so copy stays in one place.
 */

import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { requirePermission, type AccessDecision } from "@/lib/access-policy";
import { sendEmail } from "@/lib/email";
import { CONTACT, PRODUCT_NAME } from "@/lib/portal-content";

/**
 * Gate for the partner review APIs: 401 without an active session (including
 * stale session versions), 403 when the effective permissions lack
 * partners.review. Mirrors requirePermission's status-code contract.
 */
export async function requirePartnerReviewer(): Promise<AccessDecision> {
  const session = await getServerSession(authOptions);
  return requirePermission(session, "partners.review");
}

/** The full PartnerApplication.status vocabulary (see schema.prisma). */
export const PARTNER_APPLICATION_STATUSES = ["SUBMITTED", "INFO_REQUESTED", "APPROVED", "REJECTED"] as const;

/** Agency short codes: 3-10 uppercase letters, e.g. ACME. */
export const SHORT_CODE_PATTERN = /^[A-Z]{3,10}$/;

/**
 * Derives a short-code proposal from the company name: letters only,
 * uppercased, first 10. Returns null when fewer than 3 letters remain — the
 * caller must then require an explicit code from the reviewer.
 */
export function proposeShortCode(companyLegalName: string): string | null {
  const proposed = companyLegalName.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 10);
  return proposed.length >= 3 ? proposed : null;
}

export type PartnerDecision = "APPROVED" | "REJECTED" | "INFO_REQUESTED";

export interface ApplicantDecisionEmailInput {
  to: string;
  reference: string;
  companyLegalName: string;
  decision: PartnerDecision;
  decisionNote?: string | null;
}

const DECISION_SUBJECTS: Record<PartnerDecision, string> = {
  APPROVED: "approved",
  REJECTED: "rejected",
  "INFO_REQUESTED": "additional information needed",
};

function decisionBody(input: ApplicantDecisionEmailInput): string {
  const lines: string[] = [
    `Hello,`,
    ``,
    `this is an update on the partner application "${input.companyLegalName}" (reference ${input.reference}).`,
    ``,
  ];

  if (input.decision === "APPROVED") {
    lines.push(
      `Good news: your application has been approved. Welcome aboard!`,
      ``,
      `Our team will be in touch with you about the next steps.`,
    );
  } else if (input.decision === "REJECTED") {
    lines.push(
      `After careful review, we are unable to approve your application at this time.`,
    );
    if (input.decisionNote) {
      lines.push(``, `Explanation:`, input.decisionNote);
    }
  } else {
    lines.push(
      `We need some additional information before we can continue with your application.`,
    );
    if (input.decisionNote) {
      lines.push(``, `What we need:`, input.decisionNote);
    }
  }

  lines.push(
    ``,
    `If you have questions, you can reach us at ${CONTACT.email}.`,
    ``,
    `Kind regards,`,
    `${PRODUCT_NAME}`,
  );
  return lines.join("\n");
}

/**
 * Emails the applicant about the review outcome. Wraps lib/email's sendEmail
 * and NEVER throws into callers — a decision that is already stored must not
 * fail because the mail could not be delivered; returns false on failure.
 */
export async function sendApplicantDecisionEmail(input: ApplicantDecisionEmailInput): Promise<boolean> {
  try {
    await sendEmail({
      to: input.to,
      subject: `Your partner application ${input.reference} — ${DECISION_SUBJECTS[input.decision]}`,
      text: decisionBody(input),
    });
    return true;
  } catch (error) {
    console.error("[partners/review] decision email failed:", (error as Error)?.message ?? error);
    return false;
  }
}
