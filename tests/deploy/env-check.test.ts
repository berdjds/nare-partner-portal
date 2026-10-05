/**
 * Start-up environment-check tests (W7a, task env-check) for lib/env-check.ts
 * and its wiring in server.ts.
 *
 * In production a missing, placeholder or shorter-than-16-chars session
 * secret must be fatal (server.ts logs one line and exits 1 before
 * listening); 16-31 chars and a missing NEXTAUTH_URL are warnings. Outside
 * production nothing is fatal so local dev and CI keep booting with weak
 * secrets. Messages must never contain the secret value, because they go to
 * the deploy log verbatim — the tests build secret values at run time and
 * assert they never appear in any message.
 */

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { checkEnvironment } from "@/lib/env-check";

function secretOf(length: number): string {
  return "s7".repeat(Math.ceil(length / 2)).slice(0, length);
}

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { NEXTAUTH_URL: "https://portal.example.com", ...overrides, NODE_ENV: "production" };
}

function allMessages(result: { fatal: string[]; warnings: string[] }): string[] {
  return [...result.fatal, ...result.warnings];
}

describe("checkEnvironment in production", () => {
  it("missing NEXTAUTH_SECRET is fatal", () => {
    const result = checkEnvironment(envWith({}));
    expect(result.fatal).toHaveLength(1);
    expect(result.fatal[0]).toMatch(/NEXTAUTH_SECRET is not set/);
  });

  it("empty NEXTAUTH_SECRET is fatal", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: "" }));
    expect(result.fatal).toHaveLength(1);
  });

  it("a value containing the placeholder marker is fatal", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: String("please-change-me-now") }));
    expect(result.fatal).toHaveLength(1);
    expect(result.fatal[0]).toMatch(/placeholder/);
  });

  it("the exact .env.example value is fatal", () => {
    const result = checkEnvironment(
      envWith({ NEXTAUTH_SECRET: String("change-me-in-production-min-32-characters") }),
    );
    expect(result.fatal).toHaveLength(1);
    expect(result.fatal[0]).toMatch(/placeholder/);
  });

  it("a 15-character secret is fatal (below the 16-character minimum)", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: secretOf(15) }));
    expect(result.fatal).toHaveLength(1);
    expect(result.fatal[0]).toMatch(/shorter than 16/);
  });

  it("a 16-character secret is a warning, not fatal", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: secretOf(16) }));
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("recommended 32"))).toBe(true);
  });

  it("a 31-character secret is a warning, not fatal", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: secretOf(31) }));
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("recommended 32"))).toBe(true);
  });

  it("a 32-character secret with NEXTAUTH_URL set passes cleanly", () => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: secretOf(32) }));
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("missing NEXTAUTH_URL is a warning", () => {
    const result = checkEnvironment({
      NODE_ENV: "production",
      NEXTAUTH_SECRET: secretOf(32),
    });
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("NEXTAUTH_URL"))).toBe(true);
  });
});

describe("checkEnvironment outside production", () => {
  it("a missing secret is a warning, never fatal", () => {
    const result = checkEnvironment({ NODE_ENV: "development" });
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("NEXTAUTH_SECRET is not set"))).toBe(true);
  });

  it("the placeholder value is a warning, never fatal", () => {
    const result = checkEnvironment({
      NODE_ENV: "test",
      NEXTAUTH_URL: "http://localhost:3000",
      NEXTAUTH_SECRET: String("change-me-in-production-min-32-characters"),
    });
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("placeholder"))).toBe(true);
  });

  it("a short secret is a warning, never fatal", () => {
    const result = checkEnvironment({
      NODE_ENV: "development",
      NEXTAUTH_URL: "http://localhost:3000",
      NEXTAUTH_SECRET: secretOf(8),
    });
    expect(result.fatal).toHaveLength(0);
    expect(result.warnings.some((m) => m.includes("shorter than 16"))).toBe(true);
  });
});

describe("checkEnvironment messages never leak the secret value", () => {
  it.each([
    ["short", secretOf(15)],
    ["placeholder", String("change-me-in-production-min-32-characters")],
    ["boundary-16", secretOf(16)],
    ["boundary-31", secretOf(31)],
    ["ok-32", secretOf(32)],
  ])("no message contains the %s value", (_label, secret) => {
    const result = checkEnvironment(envWith({ NEXTAUTH_SECRET: secret }));
    for (const message of allMessages(result)) {
      expect(message).not.toContain(secret);
    }
  });
});

describe("server.ts env-check wiring", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf8");

  it("calls checkEnvironment()", () => {
    expect(source).toContain("checkEnvironment()");
  });

  it("runs the check before the server listens", () => {
    expect(source.indexOf("checkEnvironment()")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("checkEnvironment()")).toBeLessThan(source.indexOf(".listen("));
  });

  it("exits with code 1 on a fatal result", () => {
    expect(source).toMatch(/fatal\.length > 0[\s\S]*?process\.exit\(1\)/);
  });

  it("logs warnings", () => {
    expect(source).toContain("envCheck.warnings");
  });
});
