/**
 * W7a raw-HTML guard (task qr-safe). dangerouslySetInnerHTML injects markup
 * without escaping, so it is banned from app/ and components/: untrusted
 * strings (the WhatsApp pairing QR SVG is the case that motivated this) must
 * reach the DOM through React's own escaping or a data-URI <img>, never as
 * raw HTML. The detector is a pure function over source text — the same
 * pattern as tests/ui/design-guard.test.ts — so the negative tests at the
 * bottom can prove the guard bites on fixture strings instead of only
 * asserting the current tree is clean.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function walkSourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const rel = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSourceFiles(rel));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

export interface RawHtmlViolation {
  token: string;
  line: number;
}

/** Every use of raw-HTML injection in a source string, with line numbers. */
export function findRawHtmlViolations(source: string): RawHtmlViolation[] {
  const violations: RawHtmlViolation[] = [];
  source.split("\n").forEach((text, index) => {
    if (text.includes("dangerouslySetInnerHTML")) {
      violations.push({ token: "dangerouslySetInnerHTML", line: index + 1 });
    }
  });
  return violations;
}

// Files allowed to inject raw HTML, with a reason a reviewer can judge.
// W7a leaves this list empty on purpose: the QR SVG (its last user) now
// renders through a data-URI <img>, and any new entry needs justification.
const RAW_HTML_ALLOWLIST: { file: string; reason: string }[] = [];

describe("W7a no-raw-HTML guard", () => {
  it("app/ and components/ contain no dangerouslySetInnerHTML", () => {
    const allowed = new Set(RAW_HTML_ALLOWLIST.map((e) => e.file));
    const offenders: string[] = [];
    for (const file of [...walkSourceFiles("app"), ...walkSourceFiles("components")]) {
      if (allowed.has(file)) continue;
      for (const violation of findRawHtmlViolations(readFileSync(path.join(REPO_ROOT, file), "utf8"))) {
        offenders.push(`${file}:${violation.line} ${violation.token}`);
      }
    }
    expect(
      offenders,
      `raw HTML injection found (render through React escaping or a data-URI <img> instead):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the allow-list is empty", () => {
    expect(RAW_HTML_ALLOWLIST).toEqual([]);
  });

  // Negative tests on fixture strings: the guard must bite, not just pass.
  describe("the detector rejects violating fixtures", () => {
    it("flags dangerouslySetInnerHTML in a fixture string, with its line", () => {
      const dirty = [
        `export function Badge() {`,
        `  return <div dangerouslySetInnerHTML={{ __html: svg }} />;`,
        `}`,
      ].join("\n");
      expect(findRawHtmlViolations(dirty)).toEqual([{ token: "dangerouslySetInnerHTML", line: 2 }]);
    });

    it("accepts a data-URI img fixture string", () => {
      const clean = `<img src={\`data:image/svg+xml;charset=utf-8,\${encodeURIComponent(svg)}\`} alt="QR" />`;
      expect(findRawHtmlViolations(clean)).toEqual([]);
    });
  });
});
