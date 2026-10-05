/**
 * Reset token minting, hashing and expiry (W6a).
 *
 * The emailed token is 32 random bytes encoded base64url (43 characters,
 * 256 bits of entropy — safe in a URL path or query without escaping). Only
 * the sha256 hash of the token is stored (PasswordResetToken.tokenHash), so a
 * database leak does not hand out usable links. The hash input is bound to a
 * purpose string so a hash from another feature can never be replayed here,
 * and verification compares hashes with timingSafeEqual so a forged token
 * cannot be probed character by character. Pure and node-safe.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RESET_TOKEN_BYTES = 32;
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const RESET_TOKEN_PURPOSE = "password-reset";

/** The token sent to the user; never stored. */
export function generateResetToken(): string {
  return randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

/** The value persisted in PasswordResetToken.tokenHash. */
export function hashResetToken(token: string, purpose: string = RESET_TOKEN_PURPOSE): string {
  return createHash("sha256").update(`${purpose}:${token}`).digest("hex");
}

/**
 * Timing-safe check of a presented token against a stored hash. A malformed
 * stored hash (wrong length) is rejected before the comparison; the early
 * return leaks only the length of server-side data, never the token.
 */
export function verifyResetToken(
  token: string,
  expectedHash: string,
  purpose: string = RESET_TOKEN_PURPOSE,
): boolean {
  const actual = Buffer.from(hashResetToken(token, purpose), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Expiry timestamp for a token minted at `now`. */
export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RESET_TOKEN_TTL_MS);
}

/** A token is unusable from the exact moment it expires. */
export function isResetTokenExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}
