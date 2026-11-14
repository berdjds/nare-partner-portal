/**
 * Public legal pages tests — app/terms/page.tsx and app/privacy/page.tsx,
 * rendered through components/public/LegalPage.tsx.
 *
 * Contract under test:
 *
 * - Both pages remain plain server components with the shared public chrome,
 *   noindex metadata and the legal document supplied by lib/legal-content.ts.
 * - LegalPage renders every paragraph and item, a localised linked TOC using
 *   the static section ids, and numbered h2s that can receive anchor focus.
 * - The contact card is a labelled region populated only through
 *   usePublicContact() and the existing primaryEmail()/telHref() helpers.
 *   Mocked profiles cover all values, no values and Armenian labels; the old
 *   CONTACT/OFFICE_ADDRESS rendering contract is intentionally superseded.
 * - Source guards cover token colours, safe anchor scrolling, reduced motion,
 *   the absence of rendered URL hashes and literal contact details, and the
 *   scroll margin required by the computed sticky PublicHeader height.
 *
 * Vitest only picks up *.test.ts, so elements are built with createElement
 * instead of JSX.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LEGAL_LAST_UPDATED,
  PRIVACY_NOTICE,
  TERMS_OF_USE,
  type LegalDocument,
} from "@/lib/legal-content";
import { PRODUCT_NAME, robotsDirective } from "@/lib/portal-content";
import type { PublicContact } from "@/lib/contact/service";
import { LegalPage } from "@/components/public/LegalPage";
import { LocaleProvider } from "@/lib/i18n/react";
import type { Locale } from "@/lib/i18n/locales";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";

type MockContact = PublicContact & { companyName?: string };

const { contactRef } = vi.hoisted(() => ({
  contactRef: { current: {} as MockContact },
}));

vi.mock("@/lib/contact/react", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/contact/react")>();
  return {
    ...actual,
    usePublicContact: () => contactRef.current,
  };
});

const FULL_CONTACT: MockContact = {
  companyName: "Example Travel Company",
  b2bEmail: "partners@example.test",
  generalEmail: "info@example.test",
  phones: [
    { number: "+1 202 555 0100" },
    { number: "+44 20 7946 0100" },
  ],
  address: "12 Example Avenue, Test City",
};

beforeEach(() => {
  contactRef.current = FULL_CONTACT;
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const PAGES = [
  {
    name: "Terms of Use (/terms)",
    page: TermsPage,
    metadata: termsMetadata,
    document: TERMS_OF_USE,
    relatedHref: "/privacy",
  },
  {
    name: "Privacy Notice (/privacy)",
    page: PrivacyPage,
    metadata: privacyMetadata,
    document: PRIVACY_NOTICE,
    relatedHref: "/terms",
  },
] as const;

function render(page: (typeof PAGES)[number]["page"]): string {
  return renderToStaticMarkup(createElement(page));
}

function renderLegal(document: LegalDocument, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      locale,
      children: createElement(LegalPage, { document }),
    }),
  );
}

function tocNav(html: string): string {
  const nav = /<nav aria-labelledby="legal-toc-heading"[\s\S]*?<\/nav>/.exec(html)?.[0];
  expect(nav).toBeDefined();
  return nav ?? "";
}

function contactCard(html: string): string {
  const card = /<section aria-labelledby="legal-contact-heading"[\s\S]*?<\/section>/.exec(html)?.[0];
  expect(card).toBeDefined();
  return card ?? "";
}

function utilityPx(classes: string, utility: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)${utility}-(\\d+)(?:\\s|$)`).exec(classes);
  return match ? Number(match[1]) * 4 : undefined;
}

function requiredUtilityPx(classes: string, utility: string): number {
  const value = utilityPx(classes, utility);
  expect(value, `${utility} in ${classes}`).toBeDefined();
  return value!;
}

describe.each(PAGES)("$name — rendered document", ({ page, document: doc, relatedHref }) => {
  it("renders the h1 title, the subtitle and the intro", () => {
    const html = render(page);
    expect(html).toContain("<h1");
    expect(html).toContain(escapeHtml(doc.title));
    expect(html).toContain(escapeHtml(doc.subtitle));
    expect(html).toContain(escapeHtml(doc.intro));
  });

  it("shows the last-updated line", () => {
    const html = render(page);
    expect(html).toContain("Last updated:");
    expect(html).toContain(escapeHtml(LEGAL_LAST_UPDATED));
  });

  it("renders every numbered h2 with its static id and anchor focus target", () => {
    const html = render(page);
    doc.sections.forEach((section, index) => {
      const heading = new RegExp(
        `<h2 id="${section.id}" tabindex="-1" class="([^"]*)"`,
      ).exec(html);
      expect(heading, section.title).not.toBeNull();
      expect(heading![1]).toContain("scroll-mt-");
      expect(heading![1]).toContain("legal-h2");
      expect(html).toContain(escapeHtml(`${index + 1}. ${section.title}`));
    });
  });

  it("links every section in order and keeps plain anchors for no-JS navigation", () => {
    const nav = tocNav(render(page));
    const sectionLinks = Array.from(nav.matchAll(/<a\b[^>]*href="([^"]+)"/g), (match) => match[1])
      .filter((href) => href.startsWith("#"));
    expect(sectionLinks).toEqual(doc.sections.map((section) => `#${section.id}`));
    expect(nav).toContain(`href="${relatedHref}"`);
    expect(nav).toContain("break-words");
    expect(nav).not.toContain("whitespace-nowrap");
  });

  it("gives TOC links a token-based keyboard focus ring", () => {
    const nav = tocNav(render(page));
    expect(nav).toContain("focus-visible:ring-2");
    expect(nav).toContain("focus-visible:ring-ring");
    expect(nav).toContain("focus-visible:ring-offset-2");
  });

  it("renders the shared chrome: header nav and footer legal links", () => {
    const html = render(page);
    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe("localised table of contents", () => {
  it.each([
    { locale: "en" as const, label: "On this page" },
    { locale: "hy" as const, label: "Այս էջում" },
  ])("names the nav through its visible $locale non-h2 label", ({ locale, label }) => {
    for (const document of [TERMS_OF_USE, PRIVACY_NOTICE]) {
      const html = renderLegal(document, locale);
      const nav = tocNav(html);
      expect(nav).toMatch(
        new RegExp(`<p id="legal-toc-heading"[^>]*>\\s*${label}\\s*</p>`),
      );
      expect(nav).not.toMatch(/<h2\b/);
    }
  });
});

describe("static legal section ids", () => {
  const documentVersions: readonly {
    name: string;
    versions: readonly LegalDocument[];
  }[] = [
    { name: "Terms of Use", versions: [TERMS_OF_USE] },
    { name: "Privacy Notice", versions: [PRIVACY_NOTICE] },
  ];

  it("are unique and kebab-case within every exported document version", () => {
    for (const { versions } of documentVersions) {
      for (const document of versions) {
        const ids = document.sections.map((section) => section.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });

  it("are equal across every exported language version of a document", () => {
    for (const { name, versions } of documentVersions) {
      const [first, ...otherVersions] = versions;
      expect(first.sections.length, name).toBeGreaterThan(0);
      const expected = first.sections.map((section) => section.id);
      for (const version of otherVersions) {
        expect(version.sections.map((section) => section.id), name).toEqual(expected);
      }
    }
  });
});

describe("Privacy Notice — contact card", () => {
  it("is a labelled region with every value from the full public contact profile", () => {
    const card = contactCard(render(PrivacyPage));
    expect(card).toContain('aria-labelledby="legal-contact-heading"');
    expect(card).toContain('id="legal-contact-heading"');
    expect(card).toContain("legal-h2");
    expect(card).toContain("border-border");
    expect(card).toContain("p-6");
    expect(card).toContain("Contact us");
    expect(card).toContain("Company");
    expect(card).toContain(FULL_CONTACT.companyName!);
    expect(card).toContain("Email");
    expect(card).toContain(`href="mailto:${FULL_CONTACT.b2bEmail}"`);
    expect(card).toContain("Address");
    expect(card).toContain(FULL_CONTACT.address!);
    expect(card).toContain("Phones");
    for (const phone of FULL_CONTACT.phones!) {
      expect(card).toContain(escapeHtml(phone.number));
      expect(card).toContain(`href="tel:${phone.number.replace(/[^+\d]/g, "")}"`);
    }
  });

  it("keeps only the Contact us heading when no profile values are set", () => {
    contactRef.current = {};
    const card = contactCard(render(PrivacyPage));
    expect(card).toContain("Contact us");
    expect(card).not.toContain("<dt");
    expect(card).not.toContain("<dd");
    expect(card).not.toContain("mailto:");
    expect(card).not.toContain("tel:");
    for (const label of ["Company", "Email", "Address", "Phones"]) {
      expect(card).not.toContain(`>${label}<`);
    }
  });

  it("uses Armenian heading and field labels with the same profile values", () => {
    const card = contactCard(renderLegal(PRIVACY_NOTICE, "hy"));
    expect(card).toContain("Կապվեք մեզ հետ");
    expect(card).toContain("Ընկերություն");
    expect(card).toContain("Էլ. փոստ");
    expect(card).toContain("Հասցե");
    expect(card).toContain("Հեռախոսներ");
    expect(card).toContain(FULL_CONTACT.companyName!);
    expect(card).toContain(FULL_CONTACT.b2bEmail!);
    expect(card).toContain(FULL_CONTACT.address!);
  });
});

describe("anchor scrolling and header clearance", () => {
  it("focuses the heading, honours reduced motion and never renders the URL hash", () => {
    const source = readSource("components/public/LegalPage.tsx");
    expect(source).toContain("heading.focus({ preventScroll: true })");
    expect(source).toContain("heading.scrollIntoView");
    expect(source).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")');
    expect(source).toMatch(/\? "auto"\s*:\s*"smooth"/);
    expect(source).not.toContain("location.hash");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  it("computes the sticky header height and clears it at base and sm", () => {
    const headerSource = readSource("components/public/PublicHeader.tsx");
    const headerClasses = /<header\b[\s\S]*?className="([^"]*)"/.exec(headerSource)?.[1];
    const containerClasses = /<div className="([^"]*\bpy-\d+[^"]*)"/.exec(headerSource)?.[1];
    const logoClasses = /<img\b[^>]*className="([^"]*)"/.exec(headerSource)?.[1];
    expect(headerClasses).toBeDefined();
    expect(containerClasses).toBeDefined();
    expect(logoClasses).toBeDefined();

    const verticalPadding = requiredUtilityPx(containerClasses!, "py") * 2;
    const border = headerClasses!.split(/\s+/).includes("border-b") ? 1 : 0;
    const baseHeaderHeight = requiredUtilityPx(logoClasses!, "h") + verticalPadding + border;
    const smHeaderHeight = requiredUtilityPx(logoClasses!, "sm:h") + verticalPadding + border;

    const html = renderLegal(TERMS_OF_USE);
    const headingAttributes = Array.from(html.matchAll(/<h2\b([^>]*)>/g), (match) => match[1])
      .find((attributes) => attributes.includes(`id="${TERMS_OF_USE.sections[0].id}"`));
    expect(headingAttributes).toBeDefined();
    const headingClasses = /class="([^"]*)"/.exec(headingAttributes!)?.[1] ?? "";
    const baseScrollMargin = requiredUtilityPx(headingClasses, "scroll-mt");
    const smScrollMargin = utilityPx(headingClasses, "sm:scroll-mt") ?? baseScrollMargin;

    expect(baseScrollMargin).toBeGreaterThanOrEqual(baseHeaderHeight);
    expect(smScrollMargin).toBeGreaterThanOrEqual(smHeaderHeight);
  });
});

describe("Terms of Use — content spot-checks", () => {
  it("renders a sample paragraph from the drafted text", () => {
    expect(render(TermsPage)).toContain(
      escapeHtml("Every application is reviewed by the Nare team."),
    );
  });

  it("renders the first item of the information-and-documents list", () => {
    const section = TERMS_OF_USE.sections.find(
      (value) => value.title === "Information and documents you provide",
    );
    expect(section?.items?.length).toBeGreaterThan(0);
    expect(render(TermsPage)).toContain(escapeHtml(section!.items![0]));
    expect(render(TermsPage)).toContain("list-disc");
  });
});

describe("Privacy Notice — content spot-checks", () => {
  it("renders a sample paragraph from the drafted text", () => {
    expect(render(PrivacyPage)).toContain(escapeHtml("We do not sell your information."));
  });

  it("renders the first item of the what-we-collect list", () => {
    const section = PRIVACY_NOTICE.sections.find(
      (value) => value.title === "What we collect",
    );
    expect(section?.items?.length).toBeGreaterThan(0);
    expect(render(PrivacyPage)).toContain(escapeHtml(section!.items![0]));
    expect(render(PrivacyPage)).toContain("list-disc");
  });
});

describe.each(PAGES)("$name — metadata", ({ metadata, document: doc }) => {
  it("pins the noindex default while INDEXABLE stays false", () => {
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
    for (const relativePath of SOURCES) {
      const source = readSource(relativePath);
      expect(source, relativePath).not.toMatch(hexColour);
      expect(source, relativePath).not.toMatch(paletteUtility);
    }
  });

  it("both pages wire the shared chrome and the LegalPage renderer", () => {
    for (const relativePath of ["app/terms/page.tsx", "app/privacy/page.tsx"]) {
      const source = readSource(relativePath);
      expect(source, relativePath).toContain('from "@/components/public/PublicHeader"');
      expect(source, relativePath).toContain('from "@/components/public/PublicFooter"');
      expect(source, relativePath).toContain('from "@/components/public/LegalPage"');
      expect(source).toContain("<PublicHeader");
      expect(source).toContain("<PublicFooter />");
      expect(source).toContain("<LegalPage");
    }
  });

  it("uses the public contact hook and helpers without literal contact data", () => {
    const source = readSource("components/public/LegalPage.tsx");
    expect(source).toContain("usePublicContact()");
    expect(source).toContain("primaryEmail(contact)");
    expect(source).toContain("telHref(phone.number)");
    expect(source).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
    expect(source).not.toMatch(/(?:\+|\b)\d[\d\s().-]{7,}\d/);
    expect(source).not.toMatch(/\b(?:Teryan|Yerevan|OFFICE_ADDRESS|CONTACT\.)\b/);
  });
});
