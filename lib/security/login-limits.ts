/**
 * Sign-in throttling for the credentials authorize path (W7b, REQ-2026-0008).
 *
 * Failed sign-in attempts are counted on the SecurityRequest table (kind
 * LOGIN_FAIL) — hashes only, raw emails and IP addresses are never persisted:
 *
 * - per hashed account (email): MAX_LOGIN_FAILURES_PER_ACCOUNT failures in a
 *   rolling LOGIN_ACCOUNT_WINDOW_MS window throttle the account;
 * - per hashed client IP: MAX_LOGIN_FAILURES_PER_IP failures in a rolling
 *   LOGIN_IP_WINDOW_MS window throttle the address.
 *
 * A throttled authorize() call returns null WITHOUT checking the password —
 * indistinguishable from a wrong password — so the throttle cannot reveal
 * whether the account exists or whether the password was right. Unknown
 * emails are counted exactly like known ones. A successful sign-in clears the
 * account's counter (lib/auth.ts deletes its LOGIN_FAIL rows; the shared
 * per-IP counter is untouched).
 *
 * The counter interface is injected exactly like SecurityRequestCounter in
 * lib/security/limits.ts, so tests run against an in-memory fake and
 * authorize() passes the Prisma client. Checks run before the attempt is
 * recorded, so a race can overshoot by a little — acceptable for abuse
 * protection.
 */

import { createHash } from "node:crypto";

export const MAX_LOGIN_FAILURES_PER_ACCOUNT = 8;
export const LOGIN_ACCOUNT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_LOGIN_FAILURES_PER_IP = 30;
export const LOGIN_IP_WINDOW_MS = 60 * 60 * 1000;

// Matches the documented value set on SecurityRequest.kind in schema.prisma.
export const SECURITY_REQUEST_KIND_LOGIN_FAIL = "LOGIN_FAIL";

const EMAIL_HASH_PURPOSE = "login-email";
const IP_HASH_PURPOSE = "login-ip";

/**
 * Salted one-way hash of the email a sign-in targets; the raw address is
 * never persisted (SecurityRequest.subjectHash). Normalised (trimmed,
 * lowercased) so case variations share one quota bucket. Like hashResetEmail
 * in lib/security/limits.ts, a missing NEXTAUTH_SECRET fails closed: with a
 * known salt anyone could reverse the hash over a dictionary of emails.
 */
export function hashLoginEmail(email: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to hash sign-in emails");
  return createHash("sha256")
    .update(`${EMAIL_HASH_PURPOSE}:${secret}:${email.trim().toLowerCase()}`)
    .digest("hex");
}

/** Salted one-way hash of the client IP; the raw address is never persisted. */
export function hashLoginIp(ip: string): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to hash sign-in IPs");
  return createHash("sha256").update(`${IP_HASH_PURPOSE}:${secret}:${ip}`).digest("hex");
}

/**
 * First x-forwarded-for hop (set by Traefik in production), falling back to a
 * shared "unknown" bucket that still gets rate-limited — same rule as
 * clientIpFromHeaders in lib/partners/abuse.ts, but NextAuth hands authorize()
 * the request headers as a PLAIN object (lowercase keys, values possibly
 * arrays) while route handlers hold a Headers instance, so accept both.
 */
export function clientIpFromSignInHeaders(headers: unknown): string {
  let forwarded: unknown;
  if (headers && typeof (headers as Headers).get === "function") {
    forwarded = (headers as Headers).get("x-forwarded-for");
  } else if (headers && typeof headers === "object") {
    forwarded = (headers as Record<string, unknown>)["x-forwarded-for"];
  }
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof value === "string" ? value.split(",")[0]?.trim() : "";
  return first && first.length > 0 ? first : "unknown";
}

/** The slice of PrismaClient (or a transaction client) the limit checks need. */
export interface LoginAttemptCounter {
  securityRequest: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

/**
 * Which sign-in quota was hit. firstHit is true only on the attempt where the
 * counter reaches the quota: authorize() writes the LOGIN_THROTTLED audit row
 * then and only then, so a sustained attack produces one audit row per window
 * instead of one per attempt.
 */
export interface LoginLimitVerdict {
  limit: "account" | "ip";
  firstHit: boolean;
}

/**
 * Counts stored LOGIN_FAIL rows against the two quotas. The per-account check
 * runs first because it is the tighter, account-specific signal; both
 * outcomes are indistinguishable from a wrong password to the caller.
 */
export async function checkLoginLimits(
  db: LoginAttemptCounter,
  subject: { subjectHash: string; ipHash: string },
  now: Date = new Date(),
): Promise<LoginLimitVerdict | null> {
  const accountWindowStart = new Date(now.getTime() - LOGIN_ACCOUNT_WINDOW_MS);
  const recentForAccount = await db.securityRequest.count({
    where: {
      kind: SECURITY_REQUEST_KIND_LOGIN_FAIL,
      subjectHash: subject.subjectHash,
      createdAt: { gte: accountWindowStart },
    },
  });
  if (recentForAccount >= MAX_LOGIN_FAILURES_PER_ACCOUNT) {
    return { limit: "account", firstHit: recentForAccount === MAX_LOGIN_FAILURES_PER_ACCOUNT };
  }

  const ipWindowStart = new Date(now.getTime() - LOGIN_IP_WINDOW_MS);
  const recentForIp = await db.securityRequest.count({
    where: {
      kind: SECURITY_REQUEST_KIND_LOGIN_FAIL,
      ipHash: subject.ipHash,
      createdAt: { gte: ipWindowStart },
    },
  });
  if (recentForIp >= MAX_LOGIN_FAILURES_PER_IP) {
    return { limit: "ip", firstHit: recentForIp === MAX_LOGIN_FAILURES_PER_IP };
  }

  return null;
}
