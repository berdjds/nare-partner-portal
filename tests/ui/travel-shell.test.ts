/**
 * Tests for the W4 "travel shell" change. The travel module renders inside
 * the shared AppShell (components/app/AppShell.tsx) instead of its own
 * TravelSidebar chrome, TravelShell re-exports PageHeader/BreadcrumbItem from
 * components/app/PageHeader so existing imports keep working, and no raw
 * palette class or hex literal remains in components/travel — status colour
 * comes from the badge map (badgeStatusStyles / badgeStatusTextStyles in
 * components/ui/badge.tsx) and the PDF default brand color from
 * lib/travel/branding.ts.
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/brand-tokens.test.ts (the suite runs in node, no DOM).
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function listSources(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(REPO_ROOT, rel)).isDirectory()) {
      out.push(...listSources(rel));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(rel);
    }
  }
  return out;
}

const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
// Same raw-palette detector as tests/ui/brand-tokens.test.ts: raw Tailwind
// palette utilities (e.g. amber-700, zinc-300). Token classes (primary,
// destructive, muted-foreground, sidebar-...) intentionally do not match.
const RAW_PALETTE_CLASS =
  /(red|emerald|amber|sky|zinc|slate|gray|green|blue|orange|rose|teal|cyan|indigo|violet|purple|fuchsia|pink|lime|yellow|stone|neutral)-\d{2,3}/;

describe("W4 travel shell", () => {
  it("app/travel/layout.tsx wraps travel pages in the shared AppShell", () => {
    const layout = readRepoFile("app/travel/layout.tsx");
    expect(layout).toContain('import AppShell from "@/components/app/AppShell"');
    expect(layout).toContain("<AppShell>{children}</AppShell>");
    // The travel module's own chrome is no longer wired into the layout
    // (TravelSidebar.tsx stays in place, unused, until removed separately).
    expect(layout).not.toContain("TravelSidebar");
    expect(layout).not.toContain("TravelMobileBar");
  });

  it("components/app/PageHeader.tsx holds the PageHeader implementation", () => {
    const header = readRepoFile("components/app/PageHeader.tsx");
    expect(header).toContain("export interface BreadcrumbItem");
    expect(header).toContain("export function PageHeader(");
  });

  it("TravelShell.tsx re-exports PageHeader/BreadcrumbItem from components/app/PageHeader", () => {
    const shell = readRepoFile("components/travel/TravelShell.tsx");
    expect(shell).toContain(
      'import { PageHeader, type BreadcrumbItem } from "@/components/app/PageHeader"',
    );
    expect(shell).toContain("export { PageHeader }");
    expect(shell).toContain("export type { BreadcrumbItem }");
    // The compatibility default export stays in place for existing callers.
    expect(shell).toContain("export default function TravelShell(");
    // The implementation must not live here anymore.
    expect(shell).not.toContain("export function PageHeader(");
    expect(shell).not.toContain("export interface BreadcrumbItem");
  });

  it("no raw palette class or hex literal remains anywhere in components/travel", () => {
    const files = listSources("components/travel");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readRepoFile(file);
      expect(RAW_PALETTE_CLASS.test(source), `${file} holds a raw palette class`).toBe(false);
      expect(HEX_LITERAL.test(source), `${file} holds a hex literal`).toBe(false);
    }
  });

  it("badge.tsx exports badgeStatusTextStyles with the five status keys", () => {
    const badge = readRepoFile("components/ui/badge.tsx");
    expect(badge).toContain("export const badgeStatusTextStyles");
    for (const key of ["neutral", "warning", "success", "danger", "info"]) {
      expect(badge).toMatch(new RegExp(`badgeStatusTextStyles[\\s\\S]*${key}: "text-`));
    }
  });

  it("the PDF default brand color has a single home in lib/travel/branding.ts", () => {
    const branding = readRepoFile("lib/travel/branding.ts");
    expect(branding).toContain('export const DEFAULT_BRAND_COLOR = "#16305b"');
    // Both consumers reference the constant instead of the literal.
    const templates = readRepoFile("lib/travel/pdf/templates.ts");
    expect(templates).toContain('from "../branding"');
    expect(templates).not.toContain('"#16305b"');
    const settings = readRepoFile("components/travel/SettingsPanel.tsx");
    expect(settings).toContain('from "@/lib/travel/branding"');
    expect(settings).not.toContain("#16305b");
  });
});
