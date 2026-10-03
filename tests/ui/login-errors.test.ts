/**
 * Login error mapping (W5a).
 *
 * The contract is uniformity, not just wording: every failure case must
 * return the IDENTICAL string so the login form cannot be used to enumerate
 * accounts or leak next-auth internals.
 */

import { describe, expect, it } from "vitest";
import {
  FRIENDLY_CREDENTIALS_ERROR,
  friendlyLoginError,
} from "@/lib/login-errors";

describe("friendlyLoginError", () => {
  it("maps CredentialsSignin to the friendly message", () => {
    expect(friendlyLoginError("CredentialsSignin")).toBe(
      "Email or password is incorrect."
    );
    expect(FRIENDLY_CREDENTIALS_ERROR).toBe("Email or password is incorrect.");
  });

  it("maps unknown codes to the same friendly message", () => {
    for (const code of ["SomeFutureCode", "OAuthSignin", "CallbackRouteError"]) {
      expect(friendlyLoginError(code)).toBe(FRIENDLY_CREDENTIALS_ERROR);
    }
  });

  it("maps empty string, null and undefined to the same friendly message", () => {
    expect(friendlyLoginError("")).toBe(FRIENDLY_CREDENTIALS_ERROR);
    expect(friendlyLoginError(null)).toBe(FRIENDLY_CREDENTIALS_ERROR);
    expect(friendlyLoginError(undefined)).toBe(FRIENDLY_CREDENTIALS_ERROR);
  });

  it("returns the identical string across every case", () => {
    const results = [
      friendlyLoginError("CredentialsSignin"),
      friendlyLoginError("SomeFutureCode"),
      friendlyLoginError("OAuthSignin"),
      friendlyLoginError("CallbackRouteError"),
      friendlyLoginError(""),
      friendlyLoginError(null),
      friendlyLoginError(undefined),
    ];
    for (const result of results) {
      expect(result).toBe(results[0]);
    }
  });
});
