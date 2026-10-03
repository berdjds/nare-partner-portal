/**
 * Tests for the W4 "brand tokens" change. The Nare Travel and Tours brand
 * must live in exactly one place (the CSS variables in app/globals.css),
 * with Tailwind mapping those variables and components consuming tokens
 * (bg-primary, bg-sidebar-primary, ...) instead of raw palette classes.
 * Raw status palette classes are confined to the badgeStatusStyles map in
 * components/ui/badge.tsx so the status hues never leak into buttons,
 * toasts, or the brand mark. These are source-text assertions via
 * readFileSync — the same pattern the repo uses for other non-runtime
 * artifacts (the suite runs in node, no DOM).
 *
 * Note on the hex check: globals.css carries the hex values in explanatory
 * comments (e.g. "Nare red #AE1F23"), so the no-hex assertion runs on the
 * file with block comments stripped — what matters is that no declaration
 * value or utility contains a hex literal.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
// Raw Tailwind status palette utilities (e.g. emerald-50, red-700). Token
// classes (primary, destructive, sidebar-...) intentionally do not match.
const RAW_PALETTE_CLASS =
  /(red|emerald|amber|sky|zinc|slate|gray|green|blue|orange|rose|teal|cyan|indigo|violet|purple|fuchsia|pink|lime|yellow|stone|neutral)-\d{2,3}/;

const globalsCss = readRepoFile("app/globals.css");
const globalsCssWithoutComments = globalsCss.replace(/\/\*[\s\S]*?\*\//g, "");

function tokenValue(css: string, token: string): string {
  const match = css.match(new RegExp(`${token}:\\s*([^;]+);`));
  if (!match) throw new Error(`Token ${token} not declared in app/globals.css`);
  return match[1].trim();
}

describe("W4 brand tokens", () => {
  it("globals.css holds no hex colour literals in declarations (comments stripped)", () => {
    expect(HEX_LITERAL.test(globalsCssWithoutComments)).toBe(false);
  });

  it("globals.css declares every brand token with its exact value", () => {
    const expected: Record<string, string> = {
      "--primary": "358 70% 40%", // Nare red #AE1F23
      "--ring": "358 70% 40%",
      "--foreground": "204 5% 19%", // charcoal #2D3032
      "--accent": "328 33% 93%", // plum tint
      "--accent-foreground": "328 40% 25%", // plum #592641
      "--secondary": "0 0% 93%", // #EEEEEE
      "--muted": "0 0% 93%",
      "--input": "0 0% 78%", // #C6C6C6
      "--destructive": "0 84% 60%", // bright alert red
      "--destructive-foreground": "0 0% 98%",
      "--sidebar-background": "0 0% 100%",
      "--sidebar-foreground": "204 5% 19%",
      "--sidebar-primary": "358 70% 40%",
      "--sidebar-primary-foreground": "0 0% 98%",
      "--sidebar-accent": "358 60% 95%",
      "--sidebar-accent-foreground": "358 60% 32%",
      "--sidebar-border": "0 0% 93%",
      "--sidebar-ring": "358 70% 40%",
    };
    for (const [token, value] of Object.entries(expected)) {
      expect(tokenValue(globalsCss, token)).toBe(value);
    }
  });

  it("--destructive is a distinct value from --primary (alert red vs brand red)", () => {
    expect(tokenValue(globalsCss, "--destructive")).not.toBe(tokenValue(globalsCss, "--primary"));
  });

  it("--ring reuses the --primary hue token", () => {
    expect(tokenValue(globalsCss, "--ring")).toBe(tokenValue(globalsCss, "--primary"));
  });

  it("tailwind.config.ts maps the sidebar color scale to the --sidebar-* variables", () => {
    const config = readRepoFile("tailwind.config.ts");
    expect(config).toContain("hsl(var(--sidebar-background))");
    expect(config).toContain("--sidebar-primary");
    expect(config).toContain("--sidebar-accent");
    expect(config).toContain("--sidebar-border");
    expect(config).toContain("--sidebar-ring");
  });

  it('app/layout.tsx metadata uses the exact "Nare Travel and Tours — Portal" title and names the product', () => {
    const layout = readRepoFile("app/layout.tsx");
    expect(layout).toContain("Nare Travel and Tours — Portal"); // em dash U+2014
    expect(layout).toMatch(/description:[\s\S]*Nare Travel and Tours/);
  });

  it("badge.tsx exports badgeStatusStyles with the five status keys and raw palette classes", () => {
    const badge = readRepoFile("components/ui/badge.tsx");
    expect(badge).toContain("export const badgeStatusStyles");
    for (const key of ["neutral", "warning", "success", "danger", "info"]) {
      expect(badge).toMatch(new RegExp(`${key}:`));
    }
    // The map is the single sanctioned home of raw status palette classes.
    expect(badge).toContain("border-emerald-200 bg-emerald-50 text-emerald-700");
    expect(badge).toContain("border-red-200 bg-red-50 text-red-700");
    expect(RAW_PALETTE_CLASS.test(badge)).toBe(true);
  });

  it("raw status palette classes and hex literals are confined to the badge map", () => {
    for (const file of [
      "components/ui/button.tsx",
      "components/ui/toast.tsx",
      "components/app/BrandMark.tsx",
    ]) {
      const source = readRepoFile(file);
      expect(RAW_PALETTE_CLASS.test(source)).toBe(false);
      expect(HEX_LITERAL.test(source)).toBe(false);
    }
  });

  it("toast.tsx reuses badgeStatusStyles and maps error to the danger entry", () => {
    const toast = readRepoFile("components/ui/toast.tsx");
    expect(toast).toContain('import { badgeStatusStyles } from "@/components/ui/badge"');
    expect(toast).toContain("success: badgeStatusStyles.success");
    expect(toast).toContain("error: badgeStatusStyles.danger");
    expect(toast).toContain("info: badgeStatusStyles.info");
  });

  it('BrandMark.tsx renders "Nare Travel and Tours" with a "Portal" subtitle on sidebar tokens', () => {
    const brandMark = readRepoFile("components/app/BrandMark.tsx");
    expect(brandMark).toContain("Nare Travel and Tours");
    expect(brandMark).toContain("Portal");
    expect(brandMark).toContain("bg-sidebar-primary");
    expect(brandMark).toContain("text-sidebar-primary-foreground");
    expect(brandMark).toContain("text-sidebar-foreground");
  });
});
