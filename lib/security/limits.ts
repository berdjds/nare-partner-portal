/**
 * DB-backed request limits for the W6a password-reset endpoints.
 *
 * Counts rows on the SecurityRequest table (hashes only — raw emails and IP
 * addresses are never persisted) against four quotas:
 *
 * - per hashed client IP: 5 reset requests per rolling hour (overflow is the
 *   only case the route answers with 429);
 * - per hashed email: 3 reset requests per rolling hour (the route hides this
 *   one behind the generic 200 so the limit cannot reveal account existence);
 * - globally: 200 reset requests per UTC day;
 * - confirm attempts: 10 per hashed client IP per rolling hour.
 *
 * The counter interface is injected exactly like PartnerApplicationCounter in
 * lib/partners/abuse.ts, so tests can run against an in-memory fake and the
 * route can pass a transaction client. Checks run before the insert, so a
 * race can overshoot by a little — acceptable for abuse protection.
 */

import { createHash } from "node:crypto";

export const MAX_RESET_REQUESTS_PER_IP_PER_HOUR = 5;
export const MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR = 3;
export const MAX_RESET_REQUESTS_PER_DAY_GLOBAL = 200;
export const MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR = 10;

// Matches the documented value set on SecurityRequest.kind in schema.prisma.
export const SECURITY_REQUEST_KIND_REQUEST = "PASSWORD_RESET_REQUEST";
export const SECURITY_REQUEST_KIND_CONFIRM = "PASSWORD_RESET_CONFIRM";

const HOUR_MS = 60 * 60 * 1000;

const EMAIL_HASH_PURPOSE = "password-reset-email";

// Hidden field on the /forgot-password form that bots fill and humans never
// see; any non-empty value means bot. Shared by the request route and the
// page (Next.js route modules may only export HTTP verbs, so it lives here).
export const PASSWORD_RESET_HONEYPOT_FIELD = "website";

/**
 * Salted one-way hash of the email a reset request targets; the raw address
 * is never persisted (SecurityRequest.subjectHash). Normalised (trimmed,
 * lowercased) so case variations share one quota bucket. Like hashClientIp
 * in lib/partners/abuse.ts, a missing NEXTAUTH_SECRET fails closed: with a
 * known salt anyone could reverse the hash over a dictionary of emails.
 */
export function hashResetEmail(email: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to hash reset request emails");
  return createHash("sha256")
    .update(`${EMAIL_HASH_PURPOSE}:${secret}:${email.trim().toLowerCase()}`)
    .digest("hex");
}

/** The slice of PrismaClient (or a transaction client) the limit checks need. */
export interface SecurityRequestCounter {
  securityRequest: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

/** Which request quota was hit, or null when the request may proceed. */
export type RequestLimit = "ip" | "email" | "day" | null;

/**
 * Counts stored PASSWORD_RESET_REQUEST rows against the three request quotas.
 * The per-IP check runs first because its overflow is the only one surfaced
 * to the client (as a generic 429); the per-email and global outcomes are
 * indistinguishable from success in the response.
 */
export async function checkRequestLimits(
  db: SecurityRequestCounter,
  subject: { ipHash: string; subjectHash: string },
  now: Date = new Date(),
): Promise<RequestLimit> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);

  const recentForIp = await db.securityRequest.count({
    where: { kind: SECURITY_REQUEST_KIND_REQUEST, ipHash: subject.ipHash, createdAt: { gte: hourAgo } },
  });
  if (recentForIp >= MAX_RESET_REQUESTS_PER_IP_PER_HOUR) return "ip";

  const recentForEmail = await db.securityRequest.count({
    where: {
      kind: SECURITY_REQUEST_KIND_REQUEST,
      subjectHash: subject.subjectHash,
      createdAt: { gte: hourAgo },
    },
  });
  if (recentForEmail >= MAX_RESET_REQUESTS_PER_EMAIL_PER_HOUR) return "email";

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayTotal = await db.securityRequest.count({
    where: { kind: SECURITY_REQUEST_KIND_REQUEST, createdAt: { gte: dayStart } },
  });
  if (todayTotal >= MAX_RESET_REQUESTS_PER_DAY_GLOBAL) return "day";

  return null;
}

/**
 * Counts PASSWORD_RESET_CONFIRM rows for one hashed IP over the rolling hour.
 * Confirm attempts are limited per IP only: the token itself is unguessable,
 * so the limit exists to slow online guessing against leaked tokens.
 */
export async function checkConfirmLimits(
  db: SecurityRequestCounter,
  ipHash: string,
  now: Date = new Date(),
): Promise<"ip" | null> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const recentForIp = await db.securityRequest.count({
    where: { kind: SECURITY_REQUEST_KIND_CONFIRM, ipHash, createdAt: { gte: hourAgo } },
  });
  return recentForIp >= MAX_RESET_CONFIRM_ATTEMPTS_PER_IP_PER_HOUR ? "ip" : null;
}
