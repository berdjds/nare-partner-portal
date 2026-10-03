/**
 * Public landing page tests (W5a): the rewritten app/page.tsx must keep the
 * role-based redirects for signed-in users (ADMIN → /admin, inbox roles →
 * /dashboard, travel roles → /travel) and render the public landing page
 * (Hero / HowItWorks / Benefits / ContactBlock / Footer) to everyone else —
 * including holders of inactive or revoked sessions, who count as signed out.
 *
 * The NextAuth session and the DB-backed getActiveUser() gate are mocked
 * (canUseInbox stays real), so no database queries run; the page module is
 * imported dynamically after the mocks are installed. The landing components
 * are synchronous server components, so the awaited element tree is rendered
 * to HTML with renderToStaticMarkup and asserted against the copy in
 * lib/portal-content.ts. Two source-level guards run alongside: no raw
 * colours (hex or Tailwind palette utilities) in the landing sources — the
 * hero uses the approved brand gradient — and all copy must come from
 * "@/lib/portal-content".
 */

process.env.DATABASE_URL ??= "file:/tmp/w5a-landing-test.db";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BENEFITS,
  CONTACT,
  HERO,
  HOW_IT_WORKS_STEPS,
  INDEXABLE,
  MAILTO_SUBJECTS,
  PAGE_TITLES,
  PRODUCT_NAME,
  robotsDirective,
} from "@/lib/portal-content";

const { sessionRef, activeUserRef } = vi.hoisted(() => ({
  sessionRef: { current: null as any },
  activeUserRef: { current: null as any },
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

let HomePage: typeof import("@/app/page").default;
let metadata: typeof import("@/app/page").metadata;

beforeAll(async () => {
  const mod = await import("@/app/page");
  HomePage = mod.default;
  metadata = mod.metadata;
});

beforeEach(() => {
  sessionRef.current = null;
  activeUserRef.current = null;
});

/** Session the way NextAuth returns it, plus the user row the gate resolves. */
function signedIn(role: string) {
  sessionRef.current = {
    user: { id: "u1", role, email: "u@test.io", name: "U" },
    expires: "2099-01-01",
  };
  activeUserRef.current = {
    id: "u1",
    email: "u@test.io",
    name: "U",
    role,
    sessionVersion: 0,
    permissions: new Set(),
  };
}

/** Runs the page and returns the redirect target, or null when it rendered. */
async function redirectTarget(render: () => Promise<unknown>): Promise<string | null> {
  try {
    await render();
    return null;
  } catch (err: any) {
    if (typeof err?.digest === "string" && err.digest.startsWith("NEXT_REDIRECT")) {
      return err.digest.split(";")[2];
    }
    throw err;
  }
}

/** Escapes text the way React's server renderer does, for HTML assertions. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Renders the landing page to static HTML, failing on any redirect. */
async function renderLanding(): Promise<string> {
  const tree = await HomePage();
  return renderToStaticMarkup(tree as any);
}

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const LANDING_COMPONENT_SOURCES = [
  "components/landing/Hero.tsx",
  "components/landing/HowItWorks.tsx",
  "components/landing/Benefits.tsx",
  "components/landing/ContactBlock.tsx",
  "components/landing/Footer.tsx",
];

describe("redirect branches kept", () => {
  it("ADMIN → /admin; USER → /dashboard; ADVISOR/VALIDATOR → /travel", async () => {
    signedIn("ADMIN");
    expect(await redirectTarget(() => HomePage())).toBe("/admin");
    signedIn("USER");
    expect(await redirectTarget(() => HomePage())).toBe("/dashboard");
    signedIn("ADVISOR");
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
    signedIn("VALIDATOR");
    expect(await redirectTarget(() => HomePage())).toBe("/travel");
  });
});

describe("signed-out visitors get the landing page", () => {
  it("renders all sections with the copy from the content file", async () => {
    const html = await renderLanding();

    for (const copy of [
      HERO.headline,
      HERO.subline,
      HERO.ctaLabel,
      ...HOW_IT_WORKS_STEPS.flatMap((step) => [step.title, step.body]),
      ...BENEFITS,
      CONTACT.email,
      ...CONTACT.phones,
      PRODUCT_NAME,
      "How it works",
      "Why the partner portal",
      "Contact",
    ]) {
      expect(html).toContain(escapeHtml(copy));
    }
  });

  it("links the sign-in CTA, the mailto and every phone, with no dangling assets", async () => {
    const html = await renderLanding();

    // The hero uses a text wordmark until real logo assets ship; nothing may
    // reference files under /brand/ that do not exist in this repository.
    expect(html).not.toContain("/brand/");
    expect(html).toContain('href="/login"');
    expect(html).toContain(
      `href="mailto:${CONTACT.email}?subject=${encodeURIComponent(MAILTO_SUBJECTS.contact)}"`
    );
    for (const phone of CONTACT.phones) {
      expect(html).toContain(`href="tel:${phone.replace(/\s/g, "")}"`);
    }
  });

  it("uses no banned wording (pricing, speed/automation, self-registration)", async () => {
    const html = await renderLanding();

    expect(html).not.toMatch(/\b(pricing?|costs?|fees?|cheap|discount)\b/i);
    expect(html).not.toMatch(/\b(instant(ly)?|automate[d]?|automation|real[- ]time|fast(est)?)\b/i);
    expect(html).not.toMatch(/\b(sign[- ]?up|register|create (an? )?account)\b/i);
  });
});

describe("inactive or revoked sessions count as signed out", () => {
  it("a session whose user no longer resolves gets the landing page, not a redirect", async () => {
    sessionRef.current = {
      user: { id: "u1", role: "USER", email: "u@test.io", name: "U" },
      expires: "2099-01-01",
    };
    activeUserRef.current = null; // deactivated or revoked: the gate resolves null

    const html = await renderLanding();
    expect(html).toContain(escapeHtml(HERO.headline));
  });
});

describe("metadata", () => {
  it("carries the home title and the shared robots directive", () => {
    expect(metadata.title).toBe(PAGE_TITLES.home);
    expect(metadata.robots).toBe(robotsDirective());
    // "noindex" contains the substring "index", so a bare /index/ match would
    // false-positive; assert the standalone directive instead.
    if (!INDEXABLE) {
      expect(String(metadata.robots)).toMatch(/\bnoindex\b/);
      expect(String(metadata.robots)).not.toMatch(/(^|,\s*)index\b/);
    }
  });
});

describe("no raw colours in the landing sources", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;

  it("app/page.tsx and the five landing components use neither hex colours nor palette utilities", () => {
    for (const rel of ["app/page.tsx", ...LANDING_COMPONENT_SOURCES]) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });

  it("Hero uses the approved brand gradient and a text wordmark (no image asset)", () => {
    const hero = readSource("components/landing/Hero.tsx");
    expect(hero).toContain("bg-gradient-to-br");
    expect(hero).toContain("from-primary");
    expect(hero).toContain("to-brand");
    expect(hero).toContain("{PRODUCT_NAME}");
    expect(hero).not.toContain("/brand/");
  });
});

describe("copy comes from the content file", () => {
  it("every landing component imports from @/lib/portal-content", () => {
    for (const rel of LANDING_COMPONENT_SOURCES) {
      expect(readSource(rel), rel).toMatch(/from "@\/lib\/portal-content"/);
    }
  });
});
