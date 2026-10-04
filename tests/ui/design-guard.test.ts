/**
 * W4 design guards (task ui-guards). These tests keep the portal unified:
 * they fail the moment a change re-introduces off-token colours, a page
 * outside the shared AppShell chrome, or a top-level authenticated route
 * with no entry in the navigation model.
 *
 * The detectors are pure functions over source text (readFileSync, node
 * environment — the same pattern as tests/ui/brand-tokens.test.ts), so the
 * negative tests at the bottom can prove the guards actually bite on
 * fixture strings instead of only asserting the current tree is clean.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { effectivePermissions } from "@/lib/permissions";
import { navGroupsForUser } from "@/components/app/nav";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function walkSourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const rel = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSourceFiles(rel));
    else if (/\.(ts|tsx|js|jsx|css)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guard 1 — raw palette classes and hex literals
// ---------------------------------------------------------------------------

// Raw Tailwind palette utilities (e.g. bg-red-500, text-slate-100). Token
// classes (primary, destructive, sidebar-...) intentionally do not match.
const RAW_PALETTE_CLASS =
  /\b(?:bg|text|border|ring|from|to|via)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

export interface ColorViolation {
  token: string;
  line: number;
}

/** Every raw palette class or hex literal in a source string, with lines. */
export function findColorViolations(source: string): ColorViolation[] {
  const violations: ColorViolation[] = [];
  const detectors = [RAW_PALETTE_CLASS, HEX_LITERAL].map((re) => new RegExp(re.source, "g"));
  source.split("\n").forEach((text, index) => {
    for (const detector of detectors) {
      detector.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = detector.exec(text)) !== null) {
        violations.push({ token: match[0], line: index + 1 });
      }
    }
  });
  return violations;
}

// The only files allowed to contain raw palette classes or hex literals.
// Keep this list short — a new entry needs a reason a reviewer can judge.
const COLOR_ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: "app/globals.css",
    reason: "the brand palette lives here as CSS variables by design (W4 brand tokens)",
  },
  {
    file: "tailwind.config.ts",
    reason: "maps the CSS variables into the Tailwind color scale",
  },
  {
    file: "components/ui/badge.tsx",
    reason: "badgeStatusStyles is the single sanctioned home of raw status palette classes (semantic status hues, badges only)",
  },
];

// ---------------------------------------------------------------------------
// Guard 2 — every page renders inside the shared AppShell
// ---------------------------------------------------------------------------

const APP_SHELL_IMPORT = /import\s+AppShell\s+from\s+["']@\/components\/app\/AppShell["']/;

/** Pure predicate: does this source import the shared AppShell? */
export function sourceImportsAppShell(source: string): boolean {
  return APP_SHELL_IMPORT.test(source);
}

// Pages intentionally outside the portal chrome, with a reason per entry.
const PAGE_ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: "app/page.tsx",
    reason: "root route is a pure role-based redirect — it renders no UI",
  },
  {
    file: "app/login/page.tsx",
    reason: "public unauthenticated page — deliberately outside the authenticated shell",
  },
  {
    file: "app/partners/apply/page.tsx",
    reason: "public unauthenticated partner application page (W5b) — deliberately outside the authenticated shell, like login",
  },
  {
    file: "app/terms/page.tsx",
    reason: "public unauthenticated legal page (W5f) — renders the drafted Terms of Use with the public header/footer, not the authenticated shell",
  },
  {
    file: "app/privacy/page.tsx",
    reason: "public unauthenticated legal page (W5f) — renders the drafted Privacy Notice with the public header/footer, not the authenticated shell",
  },
];

function listPages(): string[] {
  return walkSourceFiles("app").filter((f) => f.endsWith("/page.tsx") || f === "app/page.tsx");
}

/**
 * A page is inside the shared chrome when it imports AppShell itself or an
 * ancestor layout does (the whole /travel tree is covered by
 * app/travel/layout.tsx). The root layout never counts: it also wraps the
 * public login page.
 */
function pageIsInsideShell(pagePath: string): boolean {
  if (sourceImportsAppShell(readRepoFile(pagePath))) return true;
  let dir = path.posix.dirname(pagePath);
  while (dir.startsWith("app/")) {
    const layout = `${dir}/layout.tsx`;
    if (existsSync(path.join(REPO_ROOT, layout)) && sourceImportsAppShell(readRepoFile(layout))) {
      return true;
    }
    dir = path.posix.dirname(dir);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Guard 3 — the navigation model covers every top-level authenticated route
// ---------------------------------------------------------------------------

/** Top-level route ("/travel") for every authenticated page in the tree. */
export function topLevelAuthenticatedRoutes(pages: string[]): string[] {
  const routes = new Set<string>();
  const allowed = new Set(PAGE_ALLOWLIST.map((e) => e.file));
  for (const page of pages) {
    if (allowed.has(page)) continue;
    const parts = page.split("/");
    if (parts.length > 2) routes.add(`/${parts[1]}`);
  }
  return Array.from(routes).sort();
}

/** A route is covered when a nav href equals it or is its path prefix. */
export function routeCoveredByNav(route: string, hrefs: string[]): boolean {
  return hrefs.some((href) => route === href || route.startsWith(`${href}/`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("W4 design guards", () => {
  describe("guard 1: no raw palette classes or hex literals outside the allow-list", () => {
    it("app/ and components/ are token-clean", () => {
      const allowed = new Set(COLOR_ALLOWLIST.map((e) => e.file));
      const offenders: string[] = [];
      for (const file of [...walkSourceFiles("app"), ...walkSourceFiles("components")]) {
        if (allowed.has(file)) continue;
        for (const violation of findColorViolations(readRepoFile(file))) {
          offenders.push(`${file}:${violation.line} ${violation.token}`);
        }
      }
      expect(
        offenders,
        `raw palette classes / hex literals found (use tokens from app/globals.css):\n${offenders.join("\n")}`,
      ).toEqual([]);
    });

    it("every allow-list entry still exists and still needs its exemption", () => {
      for (const entry of COLOR_ALLOWLIST) {
        expect(existsSync(path.join(REPO_ROOT, entry.file)), entry.reason).toBe(true);
      }
      // badge.tsx must actually contain the status palette classes it is
      // exempted for — otherwise the exemption is stale and should shrink.
      expect(findColorViolations(readRepoFile("components/ui/badge.tsx")).length).toBeGreaterThan(0);
    });
  });

  describe("guard 2: every page is inside the shared AppShell", () => {
    it("every app/**/page.tsx imports AppShell or is covered by an ancestor layout", () => {
      const allowed = new Set(PAGE_ALLOWLIST.map((e) => e.file));
      const uncovered = listPages().filter((page) => !allowed.has(page) && !pageIsInsideShell(page));
      expect(
        uncovered,
        `pages outside the shared shell (wrap with <AppShell> or extend the allow-list with a reason):\n${uncovered.join("\n")}`,
      ).toEqual([]);
    });

    it("the allow-listed pages are exactly the root redirect, the public pages and the legal pages", () => {
      expect(PAGE_ALLOWLIST.map((e) => e.file).sort()).toEqual([
        "app/login/page.tsx",
        "app/page.tsx",
        "app/partners/apply/page.tsx",
        "app/privacy/page.tsx",
        "app/terms/page.tsx",
      ]);
      // app/page.tsx must stay a redirect-only page to keep its exemption.
      expect(readRepoFile("app/page.tsx")).toContain("redirect(");
    });
  });

  describe("guard 3: the navigation model covers every top-level authenticated route", () => {
    it("navGroupsForUser(ADMIN) has an entry for each top-level route in the page tree", () => {
      const routes = topLevelAuthenticatedRoutes(listPages());
      // The known route map; a new top-level authenticated route must extend
      // the navigation model (this assertion fails either way it drifts).
      expect(routes).toEqual(["/admin", "/calculator", "/dashboard", "/travel"]);

      const hrefs = navGroupsForUser({
        role: "ADMIN",
        permissions: effectivePermissions("ADMIN", []),
      }).flatMap((group) => group.items.map((item) => item.href));

      for (const route of routes) {
        expect(
          routeCoveredByNav(route, hrefs),
          `no navigation entry covers ${route} (hrefs: ${hrefs.join(", ")})`,
        ).toBe(true);
      }
    });
  });

  // Negative tests on fixture strings: the guards must bite, not just pass.
  describe("guard detectors reject violating fixtures", () => {
    it("flags raw palette classes and hex literals in a fixture string", () => {
      const dirty = [
        `<div className="bg-red-500 text-slate-100 ring-blue-300">`,
        `<span style={{ color: "#1CA0F2" }} />`,
      ].join("\n");
      const tokens = findColorViolations(dirty).map((v) => v.token);
      expect(tokens).toEqual(["bg-red-500", "text-slate-100", "ring-blue-300", "#1CA0F2"]);
    });

    it("accepts token classes in a fixture string", () => {
      const clean = `<div className="bg-primary text-muted-foreground border-border hover:border-border" />`;
      expect(findColorViolations(clean)).toEqual([]);
    });

    it("flags a page fixture that does not import AppShell", () => {
      expect(sourceImportsAppShell(`export default function Page() { return <div />; }`)).toBe(false);
      expect(
        sourceImportsAppShell(`import AppShell from "@/components/app/AppShell";\nexport default function Page() {}`),
      ).toBe(true);
    });

    it("flags a route with no navigation entry", () => {
      expect(routeCoveredByNav("/phantom", ["/dashboard", "/travel", "/calculator", "/admin"])).toBe(false);
      expect(routeCoveredByNav("/travel", ["/travel"])).toBe(true);
    });
  });
});
