/**
 * Plain-text transactional emails for the W6a self-service password reset.
 *
 * Deliberately plain: no HTML, no marketing, just the reset link, its
 * 30-minute expiry and an ignore-if-not-you line. The link is built from
 * NEXTAUTH_URL (the only canonical origin the deployment knows) and carries
 * the RAW token — the database only ever holds its sha256 hash
 * (PasswordResetToken.tokenHash, see lib/security/reset-token.ts). Sending
 * goes through lib/email so tests mock one place; a missing NEXTAUTH_URL
 * fails closed (the caller treats a send failure as best-effort and keeps
 * the generic response).
 */

import { sendEmail } from "@/lib/email";
import { RESET_TOKEN_TTL_MS } from "@/lib/security/reset-token";

export const RESET_PASSWORD_PATH = "/reset-password";

export const RESET_EMAIL_SUBJECT = "Reset your partner portal password";

/** Absolute reset link carrying the raw (never stored) token. */
export function buildPasswordResetLink(token: string): string {
  const baseUrl = process.env.NEXTAUTH_URL;
  if (!baseUrl) throw new Error("NEXTAUTH_URL is required to build password reset links");
  const url = new URL(RESET_PASSWORD_PATH, baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

const RESET_TOKEN_TTL_MINUTES = Math.round(RESET_TOKEN_TTL_MS / 60_000);

export function buildPasswordResetEmailText(token: string): string {
  const link = buildPasswordResetLink(token);
  return [
    "Hello,",
    "",
    "We received a request to reset the password for this account.",
    "",
    `Open this link to choose a new password. It works once and expires in ${RESET_TOKEN_TTL_MINUTES} minutes:`,
    link,
    "",
    "If you did not ask for this, you can ignore this email — your password stays the same.",
    "",
    "Nare Travel and Tours",
  ].join("\n");
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  await sendEmail({ to, subject: RESET_EMAIL_SUBJECT, text: buildPasswordResetEmailText(token) });
}

export const RESET_CONFIRMED_EMAIL_SUBJECT = "Your partner portal password was changed";

export function buildPasswordResetConfirmedEmailText(): string {
  return [
    "Hello,",
    "",
    "The password for this account was just changed, and every other signed-in session was signed out.",
    "",
    "If this was you, there is nothing more to do.",
    "If you did not change your password, contact your Nare account manager right away.",
    "",
    "Nare Travel and Tours",
  ].join("\n");
}

export async function sendPasswordResetConfirmationEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: RESET_CONFIRMED_EMAIL_SUBJECT,
    text: buildPasswordResetConfirmedEmailText(),
  });
}
