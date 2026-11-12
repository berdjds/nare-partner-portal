/**
 * Tests for the branded login page. The shared PublicHeader owns the only
 * BrandMark; app/login/page.tsx has no second lockup above its card and uses
 * the partner-portal sign-in heading. The credentials form and error toast
 * stay unchanged. The page remains outside the AppShell and carries no raw
 * palette values — colours come from the CSS-variable tokens in
 * app/globals.css.
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

describe("branded login page", () => {
  it("removes the duplicate BrandMark lockup and uses the partner portal heading", () => {
    const page = readRepoFile("app/login/page.tsx");
    expect(page).not.toContain("BrandMark");
    expect(page).toContain(
      '<CardTitle className="text-3xl">{t("login.title")}</CardTitle>'
    );
    expect(page).not.toContain("PRODUCT_NAME");
    expect(page).not.toContain("uppercase tracking-[0.2em]");
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
    expect(page).toContain('loading ? t("login.submitting") : t("login.submit")');
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
