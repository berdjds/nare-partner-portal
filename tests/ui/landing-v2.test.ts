/**
 * Landing tests (B2B cycle 1, Phase 5): the concise B2B gateway renders benefits, three service
 * groups, a four-step process and a verified-facts strip between the hero and the contact block — each
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
  B2B_SERVICES,
  BENEFITS,
  HERO,
  HOW_IT_WORKS_STEPS,
  LANDING_TITLES,
  PARTNER_APPLY,
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

describe("Phase 5 landing sections", () => {
  it("renders each section with its id and an accessible labelled heading", async () => {
    const html = await renderLanding();
    for (const [id, heading, title] of [
      ["benefits", "benefits-heading", LANDING_TITLES.benefits],
      ["services", "services-heading", LANDING_TITLES.services],
      ["how-it-works", "how-heading", LANDING_TITLES.steps],
      ["about", "about-heading", LANDING_TITLES.trust],
    ] as const) {
      expect(html, id).toMatch(new RegExp(`<section[^>]*id="${id}"[^>]*aria-labelledby="${heading}"`));
      expect(html).toContain(`id="${heading}"`);
      expect(html).toContain(escapeHtml(title));
    }
  });

  it("shows at most three service groups and exactly four steps, in an ordered list", async () => {
    const html = await renderLanding();
    expect(B2B_SERVICES.length).toBeLessThanOrEqual(3);
    for (const s of B2B_SERVICES) expect(html).toContain(escapeHtml(s.title));
    const steps = html.match(/<ol[^>]*>([\s\S]*?)<\/ol>/)![1];
    expect(steps.match(/<li/g)).toHaveLength(4);
    for (const step of HOW_IT_WORKS_STEPS) expect(html).toContain(escapeHtml(step.title));
    for (const b of BENEFITS) expect(html).toContain(escapeHtml(b));
  });

  it("renders the sections in order: hero, benefits, services, steps, about, contact", async () => {
    const html = await renderLanding();
    const at = (needle: string) => { const i = html.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const order = [HERO.headline, 'id="benefits"', 'id="services"', 'id="how-it-works"', 'id="about"', escapeHtml(LANDING_TITLES.contact)].map((n) => at(escapeHtml(n) === n ? n : n));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("exposes an accessible heading outline (one h1, then h2 per section)", async () => {
    const outline = headingOutline(await renderLanding());
    expect(outline.filter(([l]) => l === 1)).toHaveLength(1);
    expect(outline[0]).toEqual([1, HERO.headline]);
    expect(outline.filter(([l]) => l === 2).map(([, t]) => t)).toEqual([LANDING_TITLES.benefits, LANDING_TITLES.services, LANDING_TITLES.steps, LANDING_TITLES.trust, "Ready to send your first request?"]);
  });
});

describe("verified facts only", () => {
  it("states the founding year from the contact configuration (2019) and none of the retired claims", async () => {
    const html = await renderLanding();
    expect(html).toContain("Founded in 2019");
    const text = html.replace(/<[^>]+>/g, " "); // visible text only (class names such as leading-relaxed are not claims)
    for (const retired of [/2014/, /24\s*\/\s*7/, /thousands/i, /\bleading\b/i, /licensed/i, /insured/i, /global network/i, /\bsince 20/i]) expect(text).not.toMatch(retired);
  });
  it("shows only the approved contact data", async () => {
    const html = await renderLanding();
    for (const v of ["reservation@nare.am", "info@nare.am", "+374 91 005046", "+374 10 545046"]) expect(html).toContain(v);
  });
});

describe("Sign in first, Become a partner second", () => {
  it("the hero offers Sign in as the primary action and the partner application as the secondary one, in that order", async () => {
    const html = await renderLanding();
    const hero = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    const signIn = hero.indexOf('href="/login"'), apply = hero.indexOf('href="/partners/apply"');
    expect(signIn).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(signIn);
    expect(hero).toContain(">Sign in<");
    expect(hero).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
  });
  it("the sign-in page still links both /partners/apply and /login", () => {
    const html = renderLogin();
    expect(html).toContain('href="/partners/apply"');
    expect(html).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
  });
});
