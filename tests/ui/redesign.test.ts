/** Redesign (ivory/burgundy/blue, editorial serif): structural guarantees that must survive later edits. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RequestProgress, { stageIndexOf } from "@/components/travel/detail/RequestProgress";
import { AboutNare } from "@/components/landing/AboutNare";

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
    expect(css).not.toMatch(/url\(["']?https?:/);
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
    for (const f of ["hero-expo-1920.webp", "hero-expo-960.webp", "yerevan-market.webp", "about-monastery.webp"]) {
      const p = `public/brand/photos/${f}`;
      expect(existsSync(p), p).toBe(true);
      expect(statSync(p).size, p).toBeLessThan(250_000);
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

describe("staging-system landing (corrective pass 2)", () => {
  it("About Nare is a substantial story with a photograph and verified facts only", () => {
    const html = renderToStaticMarkup(createElement(AboutNare));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text.split(" ").length).toBeGreaterThan(110);
    expect(text).toContain("2019");
    expect(html).toContain("/brand/photos/about-monastery.webp");
    expect(text).not.toMatch(/\d+\+|\bleading\b|\bbest\b|award|thousands|largest|certified|licen[sc]ed/i);
  });
  it("contact details appear in the footer only: the closing band has no email, phone or address", () => {
    const src = read("components/landing/ContactBlock.tsx");
    expect(src).not.toMatch(/usePublicContact|mailto:|tel:|telHref|primaryEmail/);
    expect(read("components/public/PublicFooter.tsx")).toContain("usePublicContact");
  });
  it("content is never hidden behind a scroll animation (no reveal-up on landing sections)", () => {
    for (const f of ["Hero", "Benefits", "ServicesSection", "HowItWorks", "AboutNare", "ContactBlock"]) expect(read(`components/landing/${f}.tsx`), f).not.toContain("reveal-up");
  });
  it("services use an image-backed feature tile and the login/application pages use the clean market photo (no second logo in the picture)", () => {
    expect(read("components/landing/ServicesSection.tsx")).toContain("/brand/photos/yerevan-market.webp");
    expect(read("app/login/page.tsx")).toContain("yerevan-market.webp");
    expect(read("app/partners/apply/page.tsx")).toContain("yerevan-market.webp");
    expect(read("app/login/page.tsx")).not.toContain("hero-expo");
  });
});

describe("typography matches staging.nare.am (self-hosted, no font service)", () => {
  it("Inter, Fraunces and the Noto Armenian faces are local files declared with @font-face, and the stacks match staging's", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const css = read("app/globals.css");
    for (const f of ["inter-latin", "inter-latin-ext", "fraunces-latin", "fraunces-latin-ext", "noto-sans-armenian", "noto-serif-armenian"]) {
      expect(existsSync(`public/fonts/${f}.woff2`), f).toBe(true);
      expect(css, f).toContain(`/fonts/${f}.woff2`);
    }
    expect(css).toMatch(/--font-sans-stack:\s*"Inter"/);
    expect(css).toMatch(/--font-display-stack:\s*"Fraunces"/);
    expect(css).toMatch(/--font-display-hy-stack:\s*"Noto Serif Armenian"/);
    expect(read("public/fonts/SOURCES.md")).toContain("staging.nare.am");
    expect(read("tailwind.config.ts")).toContain('sans: ["var(--font-sans-stack)"]');
  });
  it("section titles use staging's display scale", () => {
    for (const f of ["ServicesSection", "HowItWorks", "AboutNare"]) expect(read(`components/landing/${f}.tsx`), f).toContain("text-[clamp(2.1rem,4.6vw,4rem)]");
  });
});
