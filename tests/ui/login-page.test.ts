/**
 * Sign-in page tests (W5a, task login-split).
 *
 * Covers the redesigned app/login/page.tsx: the two-column brand panel copy
 * from lib/portal-content.ts, the accessibility attributes (autocomplete
 * hints, the show/hide password toggle with aria-pressed, an accessible
 * name, a 40px hit area and visible focus), the forgot-password link, the
 * single footer credit, and the metadata layout app/login/layout.tsx (login
 * title, always noindex).
 *
 * The page is a client component whose error and caps-lock states only appear
 * after user interaction, and the submit path only runs in a browser, so
 * those are pinned by source-level guards: role="alert", the caps-lock
 * getModifierState check, the friendlyLoginError() mapping (the raw
 * next-auth error code must never reach the toast), and the unchanged
 * callbackUrl contract (signIn with redirect:false, router.push(callbackUrl),
 * default "/"). The mapper itself is covered by tests/ui/login-errors.test.ts.
 *
 * next-auth/react, next/navigation and the toast context are mocked; the page
 * is then rendered to static HTML with renderToStaticMarkup. Vitest only
 * picks up *.test.ts, so elements are built with createElement instead of
 * JSX.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FORGOT_ACCESS,
  LOGIN_PANEL,
  PAGE_TITLES,
  PRODUCT_NAME,
} from "@/lib/portal-content";
import { FRIENDLY_CREDENTIALS_ERROR } from "@/lib/login-errors";

const { signInMock, pushMock, refreshMock, toastMock, searchParamsRef } = vi.hoisted(
  () => ({
    signInMock: vi.fn(),
    pushMock: vi.fn(),
    refreshMock: vi.fn(),
    toastMock: vi.fn(),
    searchParamsRef: { current: new URLSearchParams() },
  })
);

vi.mock("next-auth/react", () => ({ signIn: signInMock }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

let LoginPage: typeof import("@/app/login/page").default;
let LoginLayout: typeof import("@/app/login/layout").default;
let loginMetadata: typeof import("@/app/login/layout").metadata;

beforeAll(async () => {
  const page = await import("@/app/login/page");
  LoginPage = page.default;
  const layout = await import("@/app/login/layout");
  LoginLayout = layout.default;
  loginMetadata = layout.metadata;
});

beforeEach(() => {
  searchParamsRef.current = new URLSearchParams();
  signInMock.mockReset();
  pushMock.mockReset();
  refreshMock.mockReset();
  toastMock.mockReset();
});

function renderLogin(): string {
  return renderToStaticMarkup(createElement(LoginPage));
}

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
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

describe("rendered markup", () => {
  it("renders the brand panel copy and the product name from the content file", () => {
    const html = renderLogin();

    expect(html).toContain(escapeHtml(PRODUCT_NAME));
    expect(html).toContain(escapeHtml(LOGIN_PANEL.headline));
    for (const bullet of LOGIN_PANEL.bullets) {
      expect(html).toContain(escapeHtml(bullet));
    }
    expect(html).toContain("Sign in to the partner portal");
  });

  it("uses the two-column layout only on large screens", () => {
    const html = renderLogin();
    const aside = html.match(/<aside\b[\s\S]*?<\/aside>/)?.[0];
    const asideClasses = aside
      ?.match(/^<aside\b[^>]*class="([^"]*)"/)?.[1]
      .split(/\s+/) ?? [];
    const cardColumnClasses = html
      .match(/<div class="([^"]*bg-background[^"]*)">/)?.[1]
      .split(/\s+/) ?? [];

    expect(html).toContain("lg:grid-cols-2");
    // below lg the band row takes its own height and the card column takes the rest (the band stays compact)
    expect(html).toMatch(/class="grid flex-1 grid-rows-\[auto_1fr\] lg:grid-cols-2 lg:grid-rows-1"/);
    expect(html.match(/<aside\b/g) ?? []).toHaveLength(1);
    expect(html.split(escapeHtml(LOGIN_PANEL.headline))).toHaveLength(2);
    expect(asideClasses).not.toContain("hidden");
    expect(asideClasses).toEqual(
      expect.arrayContaining([
        "relative",
        "flex",
        "flex-col",
        "gap-4",
        "px-6",
        "py-8",
        "lg:justify-center",
        "lg:gap-10",
        "lg:px-16",
      ])
    );
    expect(aside).toContain("text-3xl");
    expect(aside).toContain("lg:text-5xl");
    expect(aside).toContain("space-y-2");
    expect(aside).toContain("text-base");
    expect(aside).toContain("lg:space-y-4");
    expect(aside).toContain("lg:text-lg");
    expect(aside?.match(/<li\b/g) ?? []).toHaveLength(LOGIN_PANEL.bullets.length);
    expect(aside?.match(/lucide-check/g) ?? []).toHaveLength(LOGIN_PANEL.bullets.length);
    expect(cardColumnClasses).toEqual(
      expect.arrayContaining(["justify-start", "pt-10", "lg:justify-center", "lg:pt-4"])
    );
    expect(readSource("app/login/page.tsx")).not.toContain("lg:hidden");
  });

  it("carries the autocomplete hints and an accessible password show/hide toggle", () => {
    const html = renderLogin();

    // React 19's server renderer emits the autoComplete prop name verbatim
    // (only acceptCharset/htmlFor/httpEquiv are aliased); HTML attribute
    // names are ASCII case-insensitive, so the hint applies either way.
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    // Password starts hidden; the toggle is a real button with an accessible
    // name, pressed state, 40px hit area and visible keyboard focus.
    expect(html).toContain('type="password"');
    const toggle = html.match(/<button[^>]*aria-label="Show password"[^>]*>/);
    expect(toggle, "the password visibility toggle").not.toBeNull();
    expect(toggle![0]).toContain('aria-pressed="false"');
    expect(toggle![0]).toContain("h-10");
    expect(toggle![0]).toContain("w-10");
    expect(toggle![0]).toContain("focus-visible:ring-2");
    expect(toggle![0]).toContain("focus-visible:ring-ring");
  });

  it("links forgot access without a duplicate home link or local credit", () => {
    const html = renderLogin();

    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain(escapeHtml(FORGOT_ACCESS.label));
    expect(html).not.toContain("Back to home");
    expect(html.match(/Developed by Hayk FZC/g) ?? []).toHaveLength(1);
  });

  it("shows no error before the first submit attempt", () => {
    const html = renderLogin();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(escapeHtml(FRIENDLY_CREDENTIALS_ERROR));
  });

  it("renders the same form regardless of the callbackUrl parameter", () => {
    searchParamsRef.current = new URLSearchParams("callbackUrl=/travel");
    const withParam = renderLogin();

    searchParamsRef.current = new URLSearchParams();
    const withoutParam = renderLogin();

    for (const html of [withParam, withoutParam]) {
      expect(html).toMatch(/autocomplete="username"/i);
      expect(html).toContain(escapeHtml(LOGIN_PANEL.headline));
    }
  });
});

describe("submit and error handling contract (source-level)", () => {
  const source = readSource("app/login/page.tsx");

  it("keeps the credentials signIn call and the success path unchanged", () => {
    expect(source).toContain('await signIn("credentials", {');
    expect(source).toContain("redirect: false");
    expect(source).toContain('searchParams.get("callbackUrl") || "/"');
    expect(source).toContain("router.push(callbackUrl)");
    expect(source).toContain("router.refresh()");
  });

  it("maps every failure through friendlyLoginError and never shows the raw code", () => {
    expect(source).toContain("friendlyLoginError(result?.error)");
    // The raw next-auth code (e.g. "CredentialsSignin") must not reach the UI.
    expect(source).not.toContain("toast(result?.error");
    expect(source).not.toContain("CredentialsSignin");
  });

  it("renders the error inline with role=alert in addition to the toast", () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('toast(message, "error")');
  });

  it("tracks caps lock on the password field via getModifierState", () => {
    expect(source).toContain('getModifierState("CapsLock")');
    expect(source).toContain("onKeyUp={handlePasswordKeyUp}");
  });

  it("exposes the show/hide toggle state with aria-pressed", () => {
    expect(source).toContain("aria-pressed={showPassword}");
    expect(source).toContain('showPassword ? t("login.hidePassword") : t("login.showPassword")'); // English text lives in the catalogue (tests/i18n)
  });
});

describe("design and wording guards (source-level)", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;

  it("app/login sources use neither hex colours nor palette utilities", () => {
    for (const rel of ["app/login/page.tsx", "app/login/layout.tsx"]) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });

  it("uses the plum-to-pomegranate gradient and only the site header brand image", () => {
    const source = readSource("app/login/page.tsx");
    expect(source).toContain("bg-gradient-to-br");
    expect(source).toContain("from-plum");
    expect(source).toContain("to-brand");
    expect(source).not.toContain("BrandMark");

    const html = renderLogin();
    const images = html.match(/<img\b[^>]*>/g) ?? [];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/(?:\/brand\/nare-icon\.webp|%2Fbrand%2Fnare-icon\.webp)/);
    expect(html).toContain("Sign in to the partner portal");
  });

  it("takes its copy from the content file and the error mapper", () => {
    const source = readSource("app/login/page.tsx");
    expect(source).toMatch(/from "@\/lib\/portal-content"/);
    expect(source).toMatch(/from "@\/lib\/login-errors"/);
  });

  it("uses no banned wording (pricing, speed/automation, self-registration)", () => {
    const html = renderLogin();

    expect(html).not.toMatch(/\b(pricing?|costs?|fees?|cheap|discount)\b/i);
    expect(html).not.toMatch(/\b(instant(ly)?|automate[d]?|automation|real[- ]time|fast(est)?)\b/i);
    expect(html).not.toMatch(/\b(sign[- ]?up|register|create (an? )?account)\b/i);
  });
});

describe("login layout metadata", () => {
  it("carries the login title and is always noindex", () => {
    expect(loginMetadata.title).toBe(PAGE_TITLES.login);
    // "noindex" contains the substring "index", so assert the standalone
    // directive, not a bare /index/ match.
    expect(String(loginMetadata.robots)).toMatch(/\bnoindex\b/);
    expect(String(loginMetadata.robots)).not.toMatch(/(^|,\s*)index\b/);
  });

  it("renders its children unchanged", () => {
    const html = renderToStaticMarkup(
      createElement(LoginLayout, null, createElement("div", null, "marker"))
    );
    expect(html).toContain("marker");
  });
});
