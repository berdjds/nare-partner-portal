/**
 * Tests for the W6a reset token helpers (lib/security/reset-token.ts).
 */

import { describe, expect, it } from "vitest";
import {
  RESET_TOKEN_PURPOSE,
  RESET_TOKEN_TTL_MS,
  generateResetToken,
  hashResetToken,
  isResetTokenExpired,
  resetTokenExpiry,
  verifyResetToken,
} from "@/lib/security/reset-token";

describe("generateResetToken", () => {
  it("returns 43-character base64url tokens", () => {
    const token = generateResetToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("generates distinct tokens on every call", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateResetToken()));
    expect(tokens.size).toBe(100);
  });
});

describe("hashResetToken", () => {
  it("returns a 64-character hex sha256 that differs from the token", () => {
    const token = generateResetToken();
    const hash = hashResetToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
  });

  it("is deterministic for the same token and purpose", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("binds the hash to the purpose", () => {
    const token = generateResetToken();
    expect(hashResetToken(token, "another-purpose")).not.toBe(hashResetToken(token));
    expect(hashResetToken(token, "another-purpose")).not.toBe(hashResetToken(token, RESET_TOKEN_PURPOSE));
  });
});

describe("verifyResetToken", () => {
  it("accepts the token that produced the stored hash", () => {
    const token = generateResetToken();
    expect(verifyResetToken(token, hashResetToken(token))).toBe(true);
  });

  it("rejects a token altered by a single character", () => {
    const token = generateResetToken();
    const stored = hashResetToken(token);
    const lastChar = token.slice(-1);
    const altered = token.slice(0, -1) + (lastChar === "A" ? "B" : "A");
    expect(verifyResetToken(altered, stored)).toBe(false);
  });

  it("rejects a valid token checked against the wrong purpose", () => {
    const token = generateResetToken();
    const stored = hashResetToken(token, "another-purpose");
    expect(verifyResetToken(token, stored)).toBe(false);
  });

  it("rejects an empty token and a malformed stored hash without throwing", () => {
    const token = generateResetToken();
    expect(verifyResetToken("", hashResetToken(token))).toBe(false);
    expect(verifyResetToken(token, "")).toBe(false);
    expect(verifyResetToken(token, "not-a-hash")).toBe(false);
  });
});

describe("expiry", () => {
  const mintedAt = new Date("2026-10-05T12:00:00.000Z");

  it("expires exactly 30 minutes after minting", () => {
    expect(resetTokenExpiry(mintedAt).getTime()).toBe(mintedAt.getTime() + RESET_TOKEN_TTL_MS);
    expect(RESET_TOKEN_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("is still valid one millisecond before the boundary", () => {
    const expiresAt = resetTokenExpiry(mintedAt);
    expect(isResetTokenExpired(expiresAt, new Date(expiresAt.getTime() - 1))).toBe(false);
  });

  it("is expired at the exact boundary", () => {
    const expiresAt = resetTokenExpiry(mintedAt);
    expect(isResetTokenExpired(expiresAt, expiresAt)).toBe(true);
  });

  it("is expired after the boundary", () => {
    const expiresAt = resetTokenExpiry(mintedAt);
    expect(isResetTokenExpired(expiresAt, new Date(expiresAt.getTime() + 60_000))).toBe(true);
  });
});
