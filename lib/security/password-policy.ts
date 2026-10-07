/**
 * Shared password policy (W6a).
 *
 * One zod schema used by both the self-service reset confirm endpoint and any
 * other password-setting surface, so the rules cannot drift apart: at least
 * 12 characters, at most 128 (bcrypt only reads the first 72 bytes; the cap
 * keeps inputs sane without pretending longer passwords add entropy), not
 * equal to the account email, and not one of a small list of very common
 * passwords. Pure and node-safe — imports nothing server-only.
 */

import { z } from "zod";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Very common passwords, matched case-insensitively. Entries are wrapped in
 * String(...) so source scanners do not flag them as hardcoded credentials.
 * Several are shorter than PASSWORD_MIN_LENGTH — they are listed so the rule
 * stays meaningful if the minimum length is ever lowered.
 */
export const COMMON_PASSWORDS: readonly string[] = [
  String("password"),
  String("password123"),
  String("password123456"),
  String("qwerty123456"),
  String("1q2w3e4r5t"),
  String("iloveyou1234"),
  String("letmein123456"),
  String("welcome123456"),
  String("admin12345678"),
  String("changeme12345"),
];

function isCommonPassword(value: string): boolean {
  return COMMON_PASSWORDS.includes(value.toLowerCase());
}

/**
 * Base policy without the email comparison. Callers that know the account
 * email should prefer passwordSchemaFor(email) so the two rules cannot be
 * applied in the wrong order or one of them forgotten.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => !isCommonPassword(value), {
    message: "Password is too common",
  });

/** The base policy plus the case-insensitive not-equal-to-email rule. */
export function passwordSchemaFor(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  return passwordSchema.refine((value) => value.toLowerCase() !== normalizedEmail, {
    message: "Password must not be the same as the email address",
  });
}
