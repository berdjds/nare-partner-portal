/**
 * Tests for the W4 "branded login page" change. app/login/page.tsx drops the
 * WAControl "W" tile in favour of the shared BrandMark (components/app/
 * BrandMark.tsx — "Nare Travel and Tours" / "Portal" on brand tokens) and
 * keeps the credentials sign-in form and error toast byte-for-byte in
 * behaviour. The page stays outside the AppShell and carries no raw palette
 * values — colours come from the CSS-variable tokens in app/globals.css.
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/chat-shell.test.ts (the suite runs in node, no DOM).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("W4 branded login page", () => {
  it("renders the shared BrandMark instead of the WAControl tile and title", () => {
    const page = readRepoFile("app/login/page.tsx");
    expect(page).toContain('import { BrandMark } from "@/components/app/BrandMark"');
    expect(page).toContain("<BrandMark />");
    expect(page).not.toContain("WAControl");
    // The old hand-rolled "W" tile is gone.
    expect(page).not.toContain("mx-auto mb-3 flex h-11 w-11");
  });

  it("keeps the credentials sign-in behaviour unchanged", () => {
    const page = readRepoFile("app/login/page.tsx");
    expect(page).toContain('signIn("credentials", {');
    expect(page).toContain("redirect: false");
    expect(page).toContain('searchParams.get("callbackUrl") || "/"');
    expect(page).toContain("router.push(callbackUrl)");
    expect(page).toContain("router.refresh()");
    // W5a: one friendly message for every failure (lib/login-errors.ts).
    expect(page).toContain("friendlyLoginError(result?.error)");
    expect(page).toContain('toast(message, "error")');
    expect(page).toContain('<Suspense fallback={null}>');
    expect(page).toContain('type="email"');
    expect(page).toContain('type={showPassword ? "text" : "password"}');
    expect(page).toContain('loading ? "Signing in..." : "Sign in"');
  });

  it("uses only token-based colour classes (no raw hex or palette utilities)", () => {
    const page = readRepoFile("app/login/page.tsx");
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(page).not.toMatch(/\b(bg|text|border)-(red|green|blue|amber|yellow|slate|gray|zinc|neutral|stone)-\d/);
    expect(page).toContain("bg-background");
  });

  it("BrandMark shows the Nare product name and Portal subtitle on brand tokens", () => {
    const mark = readRepoFile("components/app/BrandMark.tsx");
    expect(mark).toContain("Nare Travel and Tours");
    expect(mark).toContain("Portal");
    expect(mark).toContain("/brand/nare-icon.webp");
    expect(mark).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
