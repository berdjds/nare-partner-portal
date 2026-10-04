/**
 * Shared public chrome tests (W5f, task pub-chrome) —
 * components/public/PublicHeader.tsx and components/public/PublicFooter.tsx,
 * and their wiring into the three public pages (app/page.tsx,
 * app/partners/apply/page.tsx, app/login/page.tsx).
 *
 * Contract under test:
 *
 * - PublicHeader renders the text wordmark (no image asset, no /brand/
 *   reference — same rule as the landing hero), the three primary links
 *   (Home, PARTNER_APPLY.linkLabel, Sign in) and a menu button wired to the
 *   nav via aria-expanded / aria-controls. The active page is exposed with
 *   aria-current="page" on exactly that link.
 * - The mobile menu toggle (useState flip, Escape-to-close, the sm:hidden
 *   button vs. the always-visible sm:flex desktop nav) only runs in a
 *   browser, so it is pinned by source-level guards, as in
 *   tests/ui/login-page.test.ts.
 * - PublicFooter renders the legal nav (Terms, Privacy), the contact mailto
 *   and one tel link per phone (spaces stripped), the office address and the
 *   copyright line with the current year.
 * - Both components use token colours only (no hex, no Tailwind palette
 *   utilities) and take all copy from "@/lib/portal-content".
 * - All three public pages import and render both chrome components; each
 *   page is rendered in its initial (signed-out) state and asserted for the
 *   header nav id, the terms link and the office address.
 *
 * The three pages need different mocks, so they are combined here: the
 * NextAuth session and the DB-backed getActiveUser() gate for the landing
 * page (as in tests/ui/landing.test.ts), next-auth/react + next/navigation +
 * the toast context for the client login page (as in
 * tests/ui/login-page.test.ts). next/navigation is mocked with importActual
 * so the landing page keeps the real redirect (NEXT_REDIRECT digest) while
 * useRouter / useSearchParams are stubbed for the login page; the signed-out
 * landing render never calls redirect. NEXTAUTH_SECRET is set before the
 * page modules are imported dynamically (the apply page's form-token mint
 * fails closed without it), mirroring tests/partners/apply-page.test.ts.
 * Vitest only picks up *.test.ts, so elements are built with createElement
 * instead of JSX.
 */

process.env.DATABASE_URL ??= "file:/tmp/w5f-pub-chrome-test.db";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTACT,
  OFFICE_ADDRESS,
  PARTNER_APPLY,
  PRODUCT_NAME,
} from "@/lib/portal-content";

const {
  sessionRef,
  activeUserRef,
  signInMock,
  pushMock,
  refreshMock,
  toastMock,
  searchParamsRef,
} = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  activeUserRef: { current: null as any },
  signInMock: vi.fn(),
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  toastMock: vi.fn(),
  searchParamsRef: { current: new URLSearchParams() },
}));

vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));

vi.mock("@/lib/access-policy", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/access-policy")>();
  return {
    ...actual,
    getActiveUser: vi.fn(async () => activeUserRef.current),
  };
});

vi.mock("next-auth/react", () => ({ signIn: signInMock }));

vi.mock("next/navigation", async (importActual) => {
  // The login page needs useRouter / useSearchParams stubbed; everything else
  // (notably redirect, whose thrown NEXT_REDIRECT digest the landing page
  // relies on) stays real.
  const actual = await importActual<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ push: pushMock, refresh: refreshMock }),
    useSearchParams: () => searchParamsRef.current,
  };
});

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// lib/partners/abuse.ts fails closed when NEXTAUTH_SECRET is unset (it signs
// the form token), so the page needs one — set before the page module loads.
process.env.NEXTAUTH_SECRET = String("apply-page-test-secret-min-32-characters!");

let HomePage: typeof import("@/app/page").default;
let PartnerApplyPage: typeof import("@/app/partners/apply/page").default;
let LoginPage: typeof import("@/app/login/page").default;
let PublicHeader: typeof import("@/components/public/PublicHeader").PublicHeader;
let PublicFooter: typeof import("@/components/public/PublicFooter").PublicFooter;

beforeAll(async () => {
  HomePage = (await import("@/app/page")).default;
  PartnerApplyPage = (await import("@/app/partners/apply/page")).default;
  LoginPage = (await import("@/app/login/page")).default;
  PublicHeader = (await import("@/components/public/PublicHeader")).PublicHeader;
  PublicFooter = (await import("@/components/public/PublicFooter")).PublicFooter;
});

beforeEach(() => {
  sessionRef.current = null;
  activeUserRef.current = null;
  searchParamsRef.current = new URLSearchParams();
  signInMock.mockReset();
  pushMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
});

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

/** Renders the landing page to static HTML in the signed-out state. */
async function renderLanding(): Promise<string> {
  const tree = await HomePage();
  return renderToStaticMarkup(tree as any);
}

function renderApplyPage(): string {
  return renderToStaticMarkup(createElement(PartnerApplyPage));
}

function renderLogin(): string {
  return renderToStaticMarkup(createElement(LoginPage));
}

describe("PublicHeader rendered (initial closed state)", () => {
  it("renders the wordmark, all three primary links and the closed menu state", () => {
    const html = renderToStaticMarkup(createElement(PublicHeader));

    expect(html).toContain('href="/"');
    expect(html).toContain('href="/partners/apply"');
    expect(html).toContain('href="/login"');
    expect(html).toContain("Home");
    expect(html).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
    expect(html).toContain("Sign in");
    expect(html).toContain(escapeHtml(PRODUCT_NAME));
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="public-header-nav"');
    expect(html).toContain('id="public-header-nav"');
  });

  it("marks exactly the /partners/apply link with aria-current when active=apply", () => {
    const html = renderToStaticMarkup(createElement(PublicHeader, { active: "apply" }));

    expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1);
    const applyLink = html.match(/<a[^>]*href="\/partners\/apply"[^>]*>/);
    expect(applyLink, "the /partners/apply link tag").not.toBeNull();
    expect(applyLink![0]).toContain('aria-current="page"');
  });

  it("emits no aria-current at all without an active page", () => {
    const html = renderToStaticMarkup(createElement(PublicHeader));

    expect(html).not.toContain("aria-current");
  });

  it("references no /brand/ assets (text wordmark only)", () => {
    const html = renderToStaticMarkup(createElement(PublicHeader, { active: "home" }));

    expect(html).not.toContain("/brand/");
  });
});

describe("PublicHeader menu toggle (source-level)", () => {
  const source = readSource("components/public/PublicHeader.tsx");

  it("drives the menu open state with useState and the toggle button", () => {
    expect(source).toContain("useState");
    expect(source).toContain("aria-expanded={open}");
    expect(source).toContain('aria-controls="public-header-nav"');
    expect(source).toContain("onClick={() => setOpen((visible) => !visible)}");
  });

  it("closes the menu on Escape", () => {
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("setOpen(false)");
  });

  it("hides the button on desktop and always shows the nav there", () => {
    // The button carries sm:hidden; the nav carries sm:flex so the links are
    // visible on desktop regardless of the (mobile-only) open state.
    const button = source.match(/<button[\s\S]*?\/>|<button[\s\S]*?<\/button>/);
    expect(button, "the menu button").not.toBeNull();
    expect(button![0]).toContain("sm:hidden");
    expect(source).toContain("sm:flex");
  });
});

describe("PublicFooter rendered", () => {
  it("renders the legal nav links", () => {
    const html = renderToStaticMarkup(createElement(PublicFooter));

    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Terms");
    expect(html).toContain("Privacy");
  });

  it("renders the contact email and every phone as text and as links", () => {
    const html = renderToStaticMarkup(createElement(PublicFooter));

    expect(html).toContain(`href="mailto:${CONTACT.email}"`);
    expect(html).toContain(escapeHtml(CONTACT.email));
    for (const phone of CONTACT.phones) {
      expect(html).toContain(escapeHtml(phone));
      expect(html).toContain(`href="tel:${phone.replace(/\s/g, "")}"`);
    }
  });

  it("renders the office address, the product name and the copyright line", () => {
    const html = renderToStaticMarkup(createElement(PublicFooter));

    expect(html).toContain(escapeHtml(OFFICE_ADDRESS));
    expect(html).toContain(escapeHtml(PRODUCT_NAME));
    expect(html).toContain("©");
    expect(html).toContain("All rights reserved");
    expect(html).toContain(String(new Date().getFullYear()));
  });
});

describe("shared chrome on the three public pages", () => {
  const PAGE_SOURCES = [
    "app/page.tsx",
    "app/partners/apply/page.tsx",
    "app/login/page.tsx",
  ];

  it("each page imports and renders PublicHeader and PublicFooter (source-level)", () => {
    for (const rel of PAGE_SOURCES) {
      const source = readSource(rel);
      expect(source, rel).toContain('from "@/components/public/PublicHeader"');
      expect(source, rel).toContain('from "@/components/public/PublicFooter"');
      expect(source, rel).toContain("<PublicHeader");
      expect(source, rel).toContain("<PublicFooter />");
    }
  });

  it("the signed-out landing page renders the header nav and the footer content", async () => {
    const html = await renderLanding();

    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain(escapeHtml(OFFICE_ADDRESS));
  });

  it("the partner apply page renders the header nav and the footer content", () => {
    const html = renderApplyPage();

    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain(escapeHtml(OFFICE_ADDRESS));
  });

  it("the sign-in page renders the header nav and the footer content", () => {
    const html = renderLogin();

    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain(escapeHtml(OFFICE_ADDRESS));
  });
});

describe("token-only colours and content source (source-level)", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;
  const CHROME_SOURCES = [
    "components/public/PublicHeader.tsx",
    "components/public/PublicFooter.tsx",
  ];

  it("both chrome components use neither hex colours nor palette utilities", () => {
    for (const rel of CHROME_SOURCES) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });

  it("both chrome components take their copy from the content file", () => {
    for (const rel of CHROME_SOURCES) {
      expect(readSource(rel), rel).toMatch(/from "@\/lib\/portal-content"/);
    }
  });
});
