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

describe("photo-led public shell (corrective pass)", () => {
  it("local approved photos exist, are small, are not hotlinked, and their provenance is recorded", () => {
    const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
    for (const f of ["hero-expo.webp", "about-monastery.webp"]) {
      const p = `public/brand/photos/${f}`;
      expect(existsSync(p), p).toBe(true);
      expect(statSync(p).size, p).toBeLessThan(200_000);
    }
    expect(existsSync("public/brand/photos/hero-aerial.webp")).toBe(false); // third-party watermark: not used
    const sources = read("public/brand/photos/SOURCES.md");
    expect(sources).toContain("staging.nare.am");
    expect(sources).toContain("Armenian Explorer");
    for (const rel of ["components/landing/Hero.tsx", "components/landing/AboutNare.tsx", "components/landing/ContactBlock.tsx", "app/login/page.tsx", "app/partners/apply/page.tsx"]) {
      expect(read(rel), rel).not.toMatch(/https?:\/\/[^"')]*\.(webp|jpe?g|png)/i);
      expect(read(rel), rel).not.toContain("hero-aerial");
    }
  });
  it("the logo appears only in the header: footer, hero and about show no brand mark", () => {
    for (const rel of ["components/public/PublicFooter.tsx", "components/landing/Hero.tsx", "components/landing/AboutNare.tsx", "components/landing/ContactBlock.tsx"]) {
      expect(read(rel), rel).not.toMatch(/nare-(logo|icon)\.webp|BrandMark/);
    }
    expect(read("components/public/PublicHeader.tsx")).toContain("/brand/nare-logo.webp");
  });
  it("the footer takes contact facts and social links from the admin-managed contact, not from hard-coded values", () => {
    const f = read("components/public/PublicFooter.tsx");
    expect(f).toContain("usePublicContact");
    expect(f).toContain("contact.social");
    expect(f).not.toMatch(/@nare\.am|\+374|facebook\.com\/|instagram\.com\/|Teryan/);
    expect(f).toContain("bg-footer");
  });
});
