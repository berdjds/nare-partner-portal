/**
 * Transactional emails for partner applications (W5b).
 *
 * Two messages per submission: a confirmation to the applicant (reference,
 * what happens next, deliberately no promised dates) and an alert to the Nare
 * reservations address so staff know the queue has new work. Both wrap
 * lib/email's sendEmail and NEVER throw into callers — email must not fail a
 * submission that is already safely stored; failures are logged instead.
 * Wording leans on lib/portal-content.ts so copy stays in one place.
 */

import { sendEmail } from "@/lib/email";
import { CONTACT, PRODUCT_NAME } from "@/lib/portal-content";

export interface ApplicantConfirmationInput {
  to: string;
  reference: string;
  companyLegalName: string;
}

export interface StaffAlertInput {
  reference: string;
  companyLegalName: string;
  contactName: string;
  contactEmail: string;
  country: string;
}

export async function sendApplicantConfirmationEmail(input: ApplicantConfirmationInput): Promise<boolean> {
  try {
    await sendEmail({
      to: input.to,
      subject: `We received your partner application (${input.reference})`,
      text: [
        `Hello,`,
        ``,
        `thank you for applying to work with ${PRODUCT_NAME}. We have received the application for "${input.companyLegalName}".`,
        ``,
        `Your application reference is ${input.reference}. Please keep it — you will need it whenever you contact us about this application.`,
        ``,
        `What happens next: our team reviews every application and the documents you sent by hand. If we need anything else from you, we will write to this email address. Once the review is finished, we will let you know the outcome here as well.`,
        ``,
        `If you have questions in the meantime, you can reach us at ${CONTACT.email}.`,
        ``,
        `Kind regards,`,
        `${PRODUCT_NAME}`,
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.error(
      "[partners/emails] applicant confirmation failed:",
      (error as Error)?.message ?? error,
    );
    return false;
  }
}

export async function sendStaffAlertEmail(input: StaffAlertInput): Promise<boolean> {
  try {
    await sendEmail({
      to: CONTACT.email,
      subject: `New partner application ${input.reference} — ${input.companyLegalName}`,
      text: [
        `A new partner application was submitted on the portal.`,
        ``,
        `Reference: ${input.reference}`,
        `Company: ${input.companyLegalName}`,
        `Country: ${input.country}`,
        `Contact: ${input.contactName} <${input.contactEmail}>`,
        ``,
        `Review it in the admin panel under Partner applications.`,
      ].join("\n"),
    });
    return true;
  } catch (error) {
    console.error("[partners/emails] staff alert failed:", (error as Error)?.message ?? error);
    return false;
  }
}
