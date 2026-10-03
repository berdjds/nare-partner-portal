/**
 * Tests for the W4 "calculator shell" change. The calculator page renders
 * inside the shared AppShell (components/app/AppShell.tsx) with variant
 * "full": app/calculator/page.tsx keeps its session/active-user guard and
 * still serves the standalone HTML from doc/temp/, while
 * components/calculator/CalculatorFrame.tsx drops its own header navigation
 * (Back button / router) in favour of a slim title bar plus the sandboxed
 * iframe sized to fill the viewport below the shell's 3.5rem mobile bar.
 * The calculator HTML itself is recoloured to the Nare brand tokens — only
 * colour values inside <style> change; the <script> block must stay
 * byte-for-byte identical (the reviewer verifies that with git diff; here we
 * pin the calculation logic, the script/style boundary, and that no colour
 * literal leaked into the script block).
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/admin-shell.test.ts (the suite runs in node, no DOM).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const CALC_HTML = "doc/temp/Hello_Armenia_Package_Calculator_2026_v3.html";

function scriptBlock(html: string): string {
  const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
  expect(scripts).toHaveLength(1);
  return scripts[0]!;
}

describe("W4 calculator shell", () => {
  it("app/calculator/page.tsx wraps the frame in AppShell variant full and keeps its guard", () => {
    const page = readRepoFile("app/calculator/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain('<AppShell variant="full">');
    expect(page).toContain("<CalculatorFrame");
    expect(page).toContain("getActiveUser");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain("Hello_Armenia_Package_Calculator_2026_v3.html");
  });

  it("CalculatorFrame.tsx drops its own navigation header and keeps a page title and the sandboxed iframe", () => {
    const frame = readRepoFile("components/calculator/CalculatorFrame.tsx");
    for (const removed of [
      "useRouter",
      "router.push",
      "ArrowLeft",
      ">Back<",
      'from "@/components/ui/button"',
    ]) {
      expect(frame).not.toContain(removed);
    }
    expect(frame).toContain("Package Calculator");
    expect(frame).toContain("Hello Armenia Package Calculator 2026");
    expect(frame).toContain("srcDoc={html}");
    expect(frame).toContain('sandbox="allow-scripts allow-same-origin allow-popups allow-forms"');
    expect(frame).toContain("h-[calc(100dvh-3.5rem)]");
    expect(frame).toContain("lg:h-dvh");
  });

  it("calculator HTML keeps its calculation script intact and free of styling changes", () => {
    const html = readRepoFile(CALC_HTML);
    const script = scriptBlock(html);

    // The recolour only touches <style>: the script comes after it and
    // carries no colour literals at all.
    expect(html.indexOf("</style>")).toBeGreaterThan(-1);
    expect(html.indexOf("<script>")).toBeGreaterThan(html.indexOf("</style>"));
    expect(script).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    // The workbook pricing logic and its inputs are pinned verbatim.
    for (const pinned of [
      'let inputMode = "USD";',
      "netPriceUSD: 860,",
      "usdAedRate: 3.69,",
      "function numberValue(id) {",
      "function setMode(mode) {",
      "function calculate() {",
      "const sellingUsd = (netUsd + totalAddition) * (1 + revenuePct);",
      "const profitUsd = sellingUsd - netUsd;",
      "const originalAed = Math.ceil(originalUsd * usdAedRate);",
      "const sellingAed = Math.floor(sellingUsd * usdAedRate);",
      'localStorage.setItem("helloArmeniaPackageCalculator2026", JSON.stringify(state));',
      "function resetCalculator() {",
      "function copyEnglishPrice() {",
      "function copyArabicPrice() {",
      'showToast("Defaults restored");',
      "loadState();",
      "updateModeUI();",
      "calculate();",
    ]) {
      expect(script).toContain(pinned);
    }
  });

  it("calculator HTML uses the Nare brand tokens and drops the old blue palette", () => {
    const html = readRepoFile(CALC_HTML);
    expect(html).toContain("--primary: #AE1F23;");
    expect(html).toContain("--primary-dark: #8B191C;");
    expect(html).toContain("--accent: #592641;");
    expect(html).toContain("--text: #2D3032;");
    for (const gone of ["#315efb", "#2449c7", "#f7b500", "#172033", "#fffbea", "#667085", "#dfe5ee"]) {
      expect(html).not.toContain(gone);
    }
    // Semantic status colours keep their own distinct tokens.
    expect(html).toContain("--success: #16865c;");
    expect(html).toContain("--danger: #cc3d3d;");
  });
});
