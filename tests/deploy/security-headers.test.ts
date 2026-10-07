/**
 * Security-header tests (W7a, REQ-2026-0008 phase 1) for next.config.js.
 *
 * The config must drop the X-Powered-By banner (poweredByHeader: false) and
 * send the standard protective headers on every route. The Content-Security-
 * Policy is deliberately limited to frame-ancestors, base-uri, form-action
 * and object-src: script-src and style-src need nonces and are a later
 * phase, so these tests also pin their absence to catch anyone adding them
 * without nonces.
 */

import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.js";

type HeaderRule = {
  source: string;
  headers: { key: string; value: string }[];
};

async function loadHeaderRules(): Promise<HeaderRule[]> {
  const headersFn = nextConfig.headers;
  expect(typeof headersFn).toBe("function");
  return (await headersFn!()) as HeaderRule[];
}

function headerMap(rules: HeaderRule[]): Record<string, string> {
  const rule = rules.find((r) => r.source === "/:path*");
  expect(rule, "a header rule with source /:path* (every route)").toBeDefined();
  return Object.fromEntries(rule!.headers.map((h) => [h.key, h.value]));
}

describe("next.config.js security headers (W7a)", () => {
  it("disables the X-Powered-By banner", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("sends exactly the expected protective headers on every route", async () => {
    const headers = headerMap(await loadHeaderRules());
    expect(headers).toEqual({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy":
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    });
  });

  it("CSP blocks framing but carries no script-src or style-src (nonce phase later)", async () => {
    const headers = headerMap(await loadHeaderRules());
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(csp).not.toMatch(/style-src/);
  });
});
