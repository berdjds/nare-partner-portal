/**
 * Public legal pages tests (W5f, task legal-pages) — app/terms/page.tsx and
 * app/privacy/page.tsx, rendered through the shared
 * components/public/LegalPage.tsx renderer.
 *
 * Contract under test:
 *
 * - Both pages are plain server components: no session, no DB, no mocks.
 *   Each renders the public chrome (PublicHeader / PublicFooter) around the
 *   shared LegalPage renderer fed with its document (TERMS_OF_USE or
 *   PRIVACY_NOTICE from lib/legal-content.ts).
 * - LegalPage renders the document faithfully: the h1 title, subtitle, the
 *   "Last updated" line with LEGAL_LAST_UPDATED, the intro, and every
 *   section as a numbered h2 ("1. ", "2. ", ...) with its paragraphs and its
 *   bullet list (list-disc). Sample paragraphs and items are spot-checked so
 *   the test catches the renderer silently dropping section content.
 * - The "Contact us" block is built from the shared CONTACT / OFFICE_ADDRESS
 *   (lib/portal-content.ts): office address as text, one mailto link for
 *   CONTACT.email and one tel link per phone with spaces stripped.
 * - Page metadata: robots is robotsDirective() — pinned to
 *   "noindex, nofollow" while INDEXABLE stays false, same owner decision as
 *   the landing page — and the title combines the document title with
 *   PRODUCT_NAME.
 * - Source-level guards: the renderer and both pages use token colours only
 *   (no hex, no Tailwind palette utilities) and wire the shared chrome
 *   components from "@/components/public/...".
 *
 * Vitest only picks up *.test.ts, so elements are built with createElement
 * instead of JSX, as in tests/ui/pub-chrome.test.ts.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGAL_LAST_UPDATED,
  PRIVACY_NOTICE,
  TERMS_OF_USE,
} from "@/lib/legal-content";
import {
  CONTACT,
  OFFICE_ADDRESS,
  PRODUCT_NAME,
  robotsDirective,
} from "@/lib/portal-content";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";

/** Escapes text the way React's server renderer does, for HTML assertions. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const PAGES = [
  {
    name: "Terms of Use (/terms)",
    page: TermsPage,
    metadata: termsMetadata,
    document: TERMS_OF_USE,
  },
  {
    name: "Privacy Notice (/privacy)",
    page: PrivacyPage,
    metadata: privacyMetadata,
    document: PRIVACY_NOTICE,
  },
] as const;

function render(page: (typeof PAGES)[number]["page"]): string {
  return renderToStaticMarkup(createElement(page));
}

describe.each(PAGES)("$name — rendered document", ({ page, document: doc }) => {
  const html = render(page);

  it("renders the h1 title, the subtitle and the intro", () => {
    expect(html).toContain(`<h1`);
    expect(html).toContain(escapeHtml(doc.title));
    expect(html).toContain(escapeHtml(doc.subtitle));
    expect(html).toContain(escapeHtml(doc.intro));
  });

  it("shows the last-updated line", () => {
    expect(html).toContain("Last updated:");
    expect(html).toContain(escapeHtml(LEGAL_LAST_UPDATED));
  });

  it("renders every section title as a numbered heading", () => {
    doc.sections.forEach((section, index) => {
      expect(html).toContain(escapeHtml(`${index + 1}. ${section.title}`));
    });
  });

  it("renders the contact block from the shared contact content", () => {
    expect(html).toContain('id="legal-contact-heading"');
    expect(html).toContain('aria-labelledby="legal-contact-heading"');
    expect(html).toContain("Contact us");
    expect(html).toContain(escapeHtml(OFFICE_ADDRESS));
    expect(html).toContain(`href="mailto:${CONTACT.email}"`);
    for (const phone of CONTACT.phones) {
      expect(html).toContain(escapeHtml(phone));
      expect(html).toContain(`href="tel:${phone.replace(/\s/g, "")}"`);
    }
  });

  it("renders the shared chrome: header nav and footer legal links", () => {
    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe("Terms of Use — content spot-checks", () => {
  const html = render(TermsPage);

  it("renders a sample paragraph from the drafted text", () => {
    expect(html).toContain(
      escapeHtml("Every application is reviewed by the Nare team."),
    );
  });

  it("renders the first item of the information-and-documents list", () => {
    const section = TERMS_OF_USE.sections.find(
      (s) => s.title === "Information and documents you provide",
    );
    expect(section?.items?.length).toBeGreaterThan(0);
    expect(html).toContain(escapeHtml(section!.items![0]));
    expect(html).toContain("list-disc");
  });
});

describe("Privacy Notice — content spot-checks", () => {
  const html = render(PrivacyPage);

  it("renders a sample paragraph from the drafted text", () => {
    expect(html).toContain(escapeHtml("We do not sell your information."));
  });

  it("renders the first item of the what-we-collect list", () => {
    const section = PRIVACY_NOTICE.sections.find(
      (s) => s.title === "What we collect",
    );
    expect(section?.items?.length).toBeGreaterThan(0);
    expect(html).toContain(escapeHtml(section!.items![0]));
    expect(html).toContain("list-disc");
  });
});

describe.each(PAGES)("$name — metadata", ({ metadata, document: doc }) => {
  it("pins the noindex default while INDEXABLE stays false", () => {
    // INDEXABLE is false today (lib/portal-content.ts): both legal pages must
    // stay out of search engines until the owner approves indexing. If
    // INDEXABLE flips, update this expectation with the owner decision.
    expect(metadata.robots).toBe(robotsDirective());
    expect(metadata.robots).toBe("noindex, nofollow");
  });

  it("titles the page with the document title and the product name", () => {
    expect(String(metadata.title)).toContain(doc.title);
    expect(String(metadata.title)).toContain(PRODUCT_NAME);
  });
});

describe("source-level guards", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;
  const SOURCES = [
    "components/public/LegalPage.tsx",
    "app/terms/page.tsx",
    "app/privacy/page.tsx",
  ];

  it("the renderer and both pages use neither hex colours nor palette utilities", () => {
    for (const rel of SOURCES) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });

  it("both pages wire the shared chrome and the LegalPage renderer", () => {
    for (const rel of ["app/terms/page.tsx", "app/privacy/page.tsx"]) {
      const source = readSource(rel);
      expect(source, rel).toContain('from "@/components/public/PublicHeader"');
      expect(source, rel).toContain('from "@/components/public/PublicFooter"');
      expect(source, rel).toContain('from "@/components/public/LegalPage"');
      expect(source, rel).toContain("<PublicHeader");
      expect(source, rel).toContain("<PublicFooter />");
      expect(source, rel).toContain("<LegalPage");
    }
  });
});
