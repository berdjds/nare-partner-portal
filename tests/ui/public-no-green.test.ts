/**
 * No-green guard for the public pages (W5e, REQ-2026-0005): the Nare public
 * surface is white/light-neutral with brand blue and a small warm-orange
 * accent — no green-family colour (green, emerald, lime, teal) and no raw
 * colours (hex or hsl literals) may appear in any public page source.
 *
 * Scanned: components/landing, components/public, app/page.tsx, app/login,
 * app/partners/apply, app/terms and app/privacy. The detectors are pure
 * functions over source text (same pattern as tests/ui/design-guard.test.ts),
 * so the negative tests at the bottom prove the guard bites on fixture
 * strings instead of only asserting the current tree is clean.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

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

// Green-family Tailwind palette utilities (e.g. bg-emerald-500, text-lime-100,
// from-teal-400). Token classes (primary, brand, warm, ...) do not match.
const GREEN_FAMILY_CLASS =
  /\b(?:bg|text|border|ring|ring-offset|from|via|to|fill|stroke|divide|placeholder|caret|accent|decoration|outline)-(?:green|emerald|lime|teal)(?:-\d{2,3})?\b/;
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;
const HSL_LITERAL = /\bhsla?\(/;

export interface PublicColourViolation {
  token: string;
  line: number;
}

/** Every green-family class or raw hex/hsl colour in a source, with lines. */
export function findPublicColourViolations(source: string): PublicColourViolation[] {
  const violations: PublicColourViolation[] = [];
  const detectors = [GREEN_FAMILY_CLASS, HEX_LITERAL, HSL_LITERAL].map(
    (re) => new RegExp(re.source, "g"),
  );
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

/** Directories scanned whole, plus the single-file public entry point. */
const SCANNED_DIRS = [
  "components/landing",
  "components/public",
  "app/login",
  "app/partners/apply",
  "app/terms",
  "app/privacy",
];
const SCANNED_FILES = ["app/page.tsx"];

function publicSources(): string[] {
  return [...SCANNED_DIRS.flatMap(walkSourceFiles), ...SCANNED_FILES].sort();
}

describe("no green or raw colours on the public pages (W5e)", () => {
  it("every public source is free of green-family classes, hex and hsl literals", () => {
    const files = publicSources();
    // The guard must actually cover the public surface it promises to scan.
    expect(files).toEqual(
      expect.arrayContaining([
        "app/page.tsx",
        "app/login/page.tsx",
        "components/landing/Hero.tsx",
        "components/landing/ServicesSection.tsx",
        "components/landing/WhyNareSection.tsx",
        "components/landing/AboutNareSection.tsx",
        "components/landing/ArmeniaGlanceSection.tsx",
        "components/public/PublicHeader.tsx",
        "components/public/PublicFooter.tsx",
      ]),
    );

    const offenders: string[] = [];
    for (const file of files) {
      for (const violation of findPublicColourViolations(readRepoFile(file))) {
        offenders.push(`${file}:${violation.line} ${violation.token}`);
      }
    }
    expect(
      offenders,
      `green-family classes / raw colours found on public pages (use tokens from app/globals.css):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the detector flags green-family classes and raw colours in fixture strings", () => {
    const dirty = [
      `<div className="bg-emerald-500 text-lime-100 border-teal-600 from-green-400">`,
      `<span style={{ color: "#00ff00", background: "hsl(140 60% 40%)" }} />`,
    ].join("\n");
    const tokens = findPublicColourViolations(dirty).map((v) => v.token);
    expect(tokens).toEqual([
      "bg-emerald-500",
      "text-lime-100",
      "border-teal-600",
      "from-green-400",
      "#00ff00",
      "hsl(",
    ]);
  });

  it("the detector accepts Nare brand token classes in a fixture string", () => {
    const clean = `<div className="bg-background text-muted-foreground bg-warm from-primary to-brand border-border" />`;
    expect(findPublicColourViolations(clean)).toEqual([]);
  });
});
