/**
 * Abuse protection for the public partner application endpoint (W5b).
 *
 * The /partners/apply form is reachable without a login, so the endpoint
 * layers several cheap checks before anything touches the database:
 *
 * - Honeypot: the form renders a hidden field that humans never fill; a
 *   non-empty value means a bot.
 * - Signed form token: the page is served with an HMAC-signed timestamp
 *   (keyed by NEXTAUTH_SECRET). Submissions arriving faster than
 *   MIN_FILL_MS after the token was issued are bots or scripts; tokens older
 *   than FORM_TOKEN_MAX_AGE_MS are stale and must be re-issued. Verification
 *   is timing-safe.
 * - Submission limits, counted on the PartnerApplication table itself: at
 *   most MAX_PER_IP_PER_HOUR applications per hashed client IP per hour and
 *   MAX_PER_DAY_GLOBAL applications per UTC day overall. The raw IP is never
 *   stored — only a salted sha256 (schema field `ipHash`, indexed).
 *
 * The client IP comes from the first x-forwarded-for entry because the app
 * always sits behind Traefik in production; anything else collapses to
 * "unknown", which still gets rate-limited as one shared bucket.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HONEYPOT_FIELD = "companyFax";
export const MIN_FILL_MS = 3_000;
export const FORM_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const MAX_PER_IP_PER_HOUR = 3;
export const MAX_PER_DAY_GLOBAL = 50;

const FORM_PURPOSE = "partner-apply-form";
const IP_HASH_PURPOSE = "partner-apply-ip";

/**
 * NEXTAUTH_SECRET signs the form token and salts the stored IP hash; it is a
 * required env var in every environment. Like the media and socket gates
 * (lib/uploads.ts, lib/socket-auth.ts), a missing secret fails closed rather
 * than degrading to a known default: a hardcoded fallback would be readable
 * from the source, letting anyone forge form tokens and brute-force the IP
 * hash over the small IPv4 space.
 */
function abuseSecret(): string | null {
  const secret = process.env.NEXTAUTH_SECRET;
  return secret && secret.length > 0 ? secret : null;
}

function signTimestamp(issuedAt: number): string | null {
  const secret = abuseSecret();
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${FORM_PURPOSE}:${issuedAt}`).digest("hex");
}

/**
 * Mints the token embedded in the application page: `<issuedAt>.<hmac>`.
 * `issuedAt` is injectable so tests (and the page) can control the clock.
 * Throws when NEXTAUTH_SECRET is unset — fail closed rather than mint a
 * token with a known default key.
 */
export function issueFormToken(issuedAt: number = Date.now()): string {
  const signature = signTimestamp(issuedAt);
  if (signature === null) throw new Error("NEXTAUTH_SECRET is required to issue form tokens");
  return `${issuedAt}.${signature}`;
}

export type FormTokenFailure = "missing" | "malformed" | "invalid_signature" | "too_fast" | "expired" | "no_secret";

export type FormTokenVerification =
  | { ok: true }
  | { ok: false; reason: FormTokenFailure };

/**
 * Verifies a submitted form token. `too_fast` (younger than MIN_FILL_MS) and
 * `expired` (older than FORM_TOKEN_MAX_AGE_MS) are both rejections; the route
 * maps every failure to the same generic 400 so bots learn nothing.
 */
export function verifyFormToken(token: string | null | undefined, now: number = Date.now()): FormTokenVerification {
  if (!token) return { ok: false, reason: "missing" };

  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const issuedAt = Number(token.slice(0, dot));
  const signature = token.slice(dot + 1);
  if (!Number.isSafeInteger(issuedAt) || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: "malformed" };
  }

  const expected = signTimestamp(issuedAt);
  if (expected === null) return { ok: false, reason: "no_secret" }; // fail closed
  const expectedBuffer = Buffer.from(expected, "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== provided.length || !timingSafeEqual(expectedBuffer, provided)) {
    return { ok: false, reason: "invalid_signature" };
  }

  const age = now - issuedAt;
  if (age < MIN_FILL_MS) return { ok: false, reason: "too_fast" };
  if (age > FORM_TOKEN_MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** First x-forwarded-for hop (set by Traefik), falling back to a shared "unknown" bucket. */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

/** Salted one-way hash of the client IP; the raw address is never persisted. */
export function hashClientIp(ip: string): string {
  const secret = abuseSecret();
  if (!secret) throw new Error("NEXTAUTH_SECRET is required to hash client IPs");
  return createHash("sha256").update(`${IP_HASH_PURPOSE}:${secret}:${ip}`).digest("hex");
}

/** The slice of PrismaClient (or a transaction client) the limit checks need. */
export interface PartnerApplicationCounter {
  partnerApplication: {
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
}

export type SubmissionLimit = "ip" | "day" | null;

/**
 * Counts already-stored applications against the two quotas. The per-IP
 * window is a rolling hour; the global window is the current UTC day. The
 * checks run before the insert, so a race can overshoot by a little — that is
 * acceptable for abuse protection and needs no extra locking.
 */
export async function checkSubmissionLimits(
  db: PartnerApplicationCounter,
  ipHash: string,
  now: Date = new Date(),
): Promise<SubmissionLimit> {
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentForIp = await db.partnerApplication.count({
    where: { ipHash, createdAt: { gte: hourAgo } },
  });
  if (recentForIp >= MAX_PER_IP_PER_HOUR) return "ip";

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayTotal = await db.partnerApplication.count({
    where: { createdAt: { gte: dayStart } },
  });
  if (todayTotal >= MAX_PER_DAY_GLOBAL) return "day";

  return null;
}
