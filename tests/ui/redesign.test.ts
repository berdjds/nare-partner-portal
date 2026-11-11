/** Redesign (ivory/burgundy/blue, editorial serif): structural guarantees that must survive later edits. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RequestProgress, { stageIndexOf } from "@/components/travel/detail/RequestProgress";

const read = (p: string) => readFileSync(p, "utf8");

describe("local fonts only", () => {
  it("the root layout does not use a font service and globals declare system serif and Armenian stacks", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toContain("next/font/google");
    expect(layout).not.toContain("fonts.googleapis");
    const css = read("app/globals.css");
    expect(css).toContain("--font-display-stack");
    expect(css).toContain("--font-armenian-stack");
    expect(css).not.toMatch(/@import\s+url\(/);
  });
  it("honours reduced motion", () => {
    expect(read("app/globals.css")).toContain("prefers-reduced-motion: reduce");
  });
});

describe("request progress", () => {
  it("maps workflow statuses to stages; changes-requested returns to the draft stage; off-path statuses are notes, not progress", () => {
    expect(stageIndexOf("DRAFT")).toBe(0);
    expect(stageIndexOf("PENDING_VALIDATION")).toBe(1);
    expect(stageIndexOf("CHANGES_REQUESTED")).toBe(0);
    expect(stageIndexOf("APPROVED")).toBe(2);
    expect(stageIndexOf("ISSUED")).toBe(3);
    expect(stageIndexOf("ACCEPTED")).toBe(4);
    expect(stageIndexOf("DECLINED")).toBe(-1);
  });
  it("renders an ordered list with the current step marked", () => {
    const html = renderToStaticMarkup(createElement(RequestProgress, { status: "PENDING_VALIDATION" }));
    expect(html).toContain('<ol aria-label="Request progress"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(RequestProgress, { status: "DECLINED" }))).toContain("Declined");
  });
});

describe("request details and new request", () => {
  it("the danger zone is collapsed by default (a closed details element) and keeps its confirmation dialog", () => {
    const src = read("components/travel/detail/OverviewTab.tsx");
    expect(src).toMatch(/<details className="group mt-6/);
    expect(src).not.toMatch(/<details[^>]*\sopen[\s>=]/);
    expect(src).toContain("Delete request {detail.packageCode}?");
  });
  it("the new-request page has a sticky summary on large screens and a bottom action bar only below lg", () => {
    const src = read("components/travel/NewRequestPage.tsx");
    expect(src).toContain('aria-label="Request summary"');
    expect(src).toContain("lg:sticky");
    expect(src).toMatch(/fixed inset-x-0 bottom-0[^"]*lg:hidden/);
    expect(src).toContain('form="nr-form"');
  });
  it("cards are 24px and use the soft shadow token", () => {
    expect(read("components/ui/card.tsx")).toContain("rounded-card");
    expect(read("tailwind.config.ts")).toContain('card: "var(--radius-card)"');
    expect(read("app/globals.css")).toMatch(/--radius-card:\s*1\.5rem/);
  });
});
