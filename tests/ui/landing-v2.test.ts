/**
 * Landing v2 tests (W5e, REQ-2026-0005): the landing page renders the four
 * approved Nare B2B sections between the hero and the contact block — each
 * with its id and an accessible heading — and both the landing and the
 * sign-in page offer the two entry links side by side: the partner
 * application (/partners/apply) and Sign in (/login).
 *
 * Rendering approach mirrors tests/ui/pub-chrome.test.ts: the NextAuth
 * session and the DB-backed getActiveUser() gate are mocked for the landing
 * page; next-auth/react, next/navigation (importActual so redirect stays
 * real) and the toast context are mocked for the client login page. Both
 * pages render signed-out to static HTML and are asserted against the copy
 * in lib/portal-content.ts — no string of the approved copy is repeated
 * here. Vitest only picks up *.test.ts, so elements are built with
 * createElement instead of JSX.
 */

process.env.DATABASE_URL ??= "file:/tmp/w5e-landing-v2-test.db";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ABOUT_NARE,
  ARMENIA_GLANCE,
  B2B_SERVICES,
  DMC_STRENGTHS,
  HERO,
  HOW_IT_WORKS_STEPS,
  LANDING_SECTION_TITLES,
  PARTNER_APPLY,
  WHY_NARE,
} from "@/lib/portal-content";

const { sessionRef, activeUserRef, signInMock, searchParamsRef } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  activeUserRef: { current: null as any },
  signInMock: vi.fn(),
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
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => searchParamsRef.current,
  };
});

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

let HomePage: typeof import("@/app/page").default;
let LoginPage: typeof import("@/app/login/page").default;

beforeAll(async () => {
  HomePage = (await import("@/app/page")).default;
  LoginPage = (await import("@/app/login/page")).default;
});

beforeEach(() => {
  sessionRef.current = null;
  activeUserRef.current = null;
  searchParamsRef.current = new URLSearchParams();
  signInMock.mockReset();
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

/** Reverses escapeHtml, for comparing heading text extracted from HTML. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Renders the landing page to static HTML in the signed-out state. */
async function renderLanding(): Promise<string> {
  const tree = await HomePage();
  return renderToStaticMarkup(tree as any);
}

function renderLogin(): string {
  return renderToStaticMarkup(createElement(LoginPage));
}

/** Every h1–h3 in document order as [level, text] pairs. */
function headingOutline(html: string): [number, string][] {
  const outline: [number, string][] = [];
  const re = /<h([123])[^>]*>([\s\S]*?)<\/h\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    outline.push([Number(match[1]), unescapeHtml(match[2].replace(/<[^>]+>/g, ""))]);
  }
  return outline;
}

describe("W5e landing sections", () => {
  it("renders each section with its id and an accessible labelled heading", async () => {
    const html = await renderLanding();

    const sections: { id: string; headingId: string; title: string }[] = [
      { id: "services", headingId: "services-heading", title: LANDING_SECTION_TITLES.services.title },
      { id: "why-nare", headingId: "why-nare-heading", title: LANDING_SECTION_TITLES.whyNare.title },
      { id: "about", headingId: "about-heading", title: ABOUT_NARE.title },
      { id: "armenia", headingId: "armenia-heading", title: LANDING_SECTION_TITLES.armenia.title },
    ];
    for (const section of sections) {
      // id and aria-labelledby on the same <section> tag (id first, as in JSX).
      expect(
        html,
        section.id,
      ).toMatch(
        new RegExp(`<section[^>]*id="${section.id}"[^>]*aria-labelledby="${section.headingId}"`),
      );
      expect(html, section.id).toContain(`id="${section.headingId}"`);
      expect(html, section.id).toContain(escapeHtml(section.title));
    }
    // The DMC strengths block is a labelled sub-section of the services
    // section, with its own h3 heading.
    expect(html).toContain('aria-labelledby="dmc-heading"');
    expect(html).toContain('id="dmc-heading"');
    expect(html).toContain(escapeHtml(LANDING_SECTION_TITLES.dmc.title));
  });

  it("renders every approved W5e content string from the content file", async () => {
    const html = await renderLanding();

    const copy = [
      LANDING_SECTION_TITLES.services.subtitle,
      ARMENIA_GLANCE.intro,
      ABOUT_NARE.body,
      ...B2B_SERVICES.flatMap((item) => [item.title, item.body]),
      ...WHY_NARE.flatMap((item) => [item.title, item.body]),
      ...DMC_STRENGTHS.flatMap((item) => [item.title, item.body]),
      ...ARMENIA_GLANCE.items.flatMap((item) => [item.title, item.body]),
    ];
    for (const text of copy) {
      expect(html, text).toContain(escapeHtml(text));
    }
  });

  it("renders the sections in order between the hero and the contact block", async () => {
    const html = await renderLanding();

    const orderedIds = ['id="services"', 'id="why-nare"', 'id="about"', 'id="armenia"'];
    const heroEnd = html.indexOf(escapeHtml(HERO.subline));
    const contactStart = html.indexOf(">Contact</h2>");
    let cursor = heroEnd;
    expect(cursor).toBeGreaterThan(-1);
    for (const marker of orderedIds) {
      const at = html.indexOf(marker, cursor);
      expect(at, `${marker} after the hero`).toBeGreaterThan(cursor);
      expect(at, `${marker} before the contact block`).toBeLessThan(contactStart);
      cursor = at;
    }
  });

  it("exposes an accessible heading outline in order (h1, then h2/h3 per section)", async () => {
    const html = await renderLanding();

    expect(headingOutline(html)).toEqual([
      [1, HERO.headline],
      [2, LANDING_SECTION_TITLES.services.title],
      [3, LANDING_SECTION_TITLES.dmc.title],
      [2, LANDING_SECTION_TITLES.whyNare.title],
      [2, ABOUT_NARE.title],
      [2, LANDING_SECTION_TITLES.armenia.title],
      [2, "How it works"],
      ...HOW_IT_WORKS_STEPS.map((step): [number, string] => [3, step.title]),
      [2, "Why the partner portal"],
      [2, "Contact"],
    ]);
  });
});

describe("Register as a partner and Sign in, side by side", () => {
  it("the landing page links both /partners/apply and /login", async () => {
    const html = await renderLanding();

    expect(html).toContain('href="/partners/apply"');
    expect(html).toContain('href="/login"');
    expect(html).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
  });

  it("the sign-in page links both /partners/apply and /login", () => {
    const html = renderLogin();

    expect(html).toContain('href="/partners/apply"');
    // The /login link is the active entry in the shared public header nav.
    expect(html).toContain('href="/login"');
    expect(html).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
  });
});
