/**
 * Tests for the shared W6a password policy (lib/security/password-policy.ts).
 * Sample passwords are built at run time so no credential-looking literal
 * appears in the source.
 */

import { describe, expect, it } from "vitest";
import {
  COMMON_PASSWORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordSchema,
  passwordSchemaFor,
} from "@/lib/security/password-policy";

/** Builds a sample password from innocuous fragments. */
function samplePassword(...fragments: string[]): string {
  return fragments.join("-");
}

const VALID = samplePassword("north", "harbor", "lantern", "48");

describe("passwordSchema", () => {
  it("accepts a compliant password", () => {
    expect(passwordSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a password of exactly the minimum length", () => {
    expect(passwordSchema.safeParse("x".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
  });

  it("rejects a password one character below the minimum length", () => {
    const result = passwordSchema.safeParse("x".repeat(PASSWORD_MIN_LENGTH - 1));
    expect(result.success).toBe(false);
  });

  it("accepts a password of exactly the maximum length", () => {
    // Distinct characters so the repetition cannot trip a common-password rule.
    const value = (VALID + "ab".repeat(PASSWORD_MAX_LENGTH)).slice(0, PASSWORD_MAX_LENGTH);
    expect(value).toHaveLength(PASSWORD_MAX_LENGTH);
    expect(passwordSchema.safeParse(value).success).toBe(true);
  });

  it("rejects a password one character above the maximum length", () => {
    expect(passwordSchema.safeParse("y".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(passwordSchema.safeParse(undefined).success).toBe(false);
    expect(passwordSchema.safeParse(123456789012).success).toBe(false);
  });

  it("rejects every password on the common list, case-insensitively", () => {
    for (const common of COMMON_PASSWORDS) {
      expect(passwordSchema.safeParse(common).success).toBe(false);
      expect(passwordSchema.safeParse(common.toUpperCase()).success).toBe(false);
    }
  });

  it("accepts a password that merely contains a common word", () => {
    const value = samplePassword(COMMON_PASSWORDS[0], "orbital", "meadow", "73");
    expect(passwordSchema.safeParse(value).success).toBe(true);
  });
});

describe("passwordSchemaFor(email)", () => {
  const email = "person@example.test";

  it("inherits the base rules", () => {
    const schema = passwordSchemaFor(email);
    expect(schema.safeParse(VALID).success).toBe(true);
    expect(schema.safeParse("x".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(schema.safeParse(COMMON_PASSWORDS[0]).success).toBe(false);
  });

  it("rejects a password equal to the email", () => {
    expect(passwordSchemaFor(email).safeParse(email).success).toBe(false);
  });

  it("rejects a password equal to the email with different casing", () => {
    expect(passwordSchemaFor(email).safeParse(email.toUpperCase()).success).toBe(false);
  });

  it("accepts a password that only shares the local part of the email", () => {
    const value = samplePassword("person", "copper", "sunset", "91");
    expect(passwordSchemaFor(email).safeParse(value).success).toBe(true);
  });
});
