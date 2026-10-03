/**
 * Sign-in page tests (W5a, task login-split).
 *
 * Covers the redesigned app/login/page.tsx: the two-column brand panel copy
 * from lib/portal-content.ts, the accessibility attributes (autocomplete
 * hints, the show/hide password toggle with aria-pressed and an accessible
 * name), the forgot-password mailto and the back-to-home link, and the
 * metadata layout app/login/layout.tsx (login title, always noindex).
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
    expect(html).toContain("Sign in");
  });

  it("uses the two-column layout only on large screens", () => {
    const html = renderLogin();

    expect(html).toContain("lg:grid-cols-2");
    // Brand panel hidden below lg; the wordmark variant is the phone-only one.
    expect(html).toContain("lg:flex");
    expect(html).toContain("lg:hidden");
  });

  it("carries the autocomplete hints and the password show/hide toggle", () => {
    const html = renderLogin();

    // React 19's server renderer emits the autoComplete prop name verbatim
    // (only acceptCharset/htmlFor/httpEquiv are aliased); HTML attribute
    // names are ASCII case-insensitive, so the hint applies either way.
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    // Password starts hidden; the toggle is a real button with an accessible
    // name and the pressed state exposed to assistive technology.
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Show password"');
  });

  it("links the forgot-password mailto and the back-to-home link", () => {
    const html = renderLogin();

    expect(html).toContain(`href="mailto:${FORGOT_ACCESS.mailto}"`);
    expect(html).toContain(escapeHtml(FORGOT_ACCESS.text));
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to home");
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
    expect(source).toContain('showPassword ? "Hide password" : "Show password"');
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

  it("uses the approved brand gradient and no image assets that do not exist", () => {
    const source = readSource("app/login/page.tsx");
    expect(source).toContain("bg-gradient-to-br");
    expect(source).toContain("from-primary");
    expect(source).toContain("to-brand");
    // The Nare icon comes from the shared BrandMark (W4 asset on main).
    expect(source).toContain("<BrandMark />");
    expect(renderLogin()).toContain("/brand/nare-icon.webp");
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
