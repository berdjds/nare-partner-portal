/**
 * Self-service password-reset page tests (W6a).
 *
 * Covers the public pair app/forgot-password/page.tsx (request step) and
 * app/reset-password/page.tsx (confirm step, reached from the emailed link)
 * plus their client forms components/auth/ForgotPasswordForm.tsx and
 * components/auth/ResetPasswordForm.tsx, and the sign-in page link that
 * replaced the old forgot-password mailto.
 *
 * Contract under test:
 *
 * - Rendered markup: the FORGOT_PAGE / RESET_PAGE copy from
 *   lib/portal-content.ts, the public chrome (PublicHeader nav id and the
 *   PublicFooter /terms link), the labelled fields (htmlFor/id pairs), the
 *   autocomplete hints, the anti-bot honeypot (hidden, aria-hidden,
 *   tabIndex -1, autoComplete off), the aria-live status region, the
 *   show/hide password toggle with aria-pressed, and the no-token state of
 *   the reset page (invalid-link alert and a link back to /forgot-password).
 * - Metadata: both pages take their title from PAGE_TITLES and stay noindex.
 * - The form submits (fetch to the W6a endpoints, the exact JSON bodies, the
 *   client-side mismatch check, the honeypot field name shared with the
 *   server via PASSWORD_RESET_HONEYPOT_FIELD) only run in a browser, so they
 *   are pinned by source-level guards with readFileSync — the same pattern
 *   as tests/ui/login-page.test.ts. The same guards pin the design rules
 *   (token colours only) and that the forms keep no state outside React
 *   (no localStorage).
 *
 * next-auth/react, next/navigation and the toast context are mocked exactly
 * like tests/ui/login-page.test.ts so the sign-in page can be rendered too;
 * the hoisted searchParamsRef makes useSearchParams() controllable so the
 * reset form can be rendered with and without a token. Vitest only picks up
 * *.test.ts, so elements are built with createElement instead of JSX.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FORGOT_ACCESS,
  FORGOT_PAGE,
  PAGE_TITLES,
  RESET_PAGE,
} from "@/lib/portal-content";
import { PASSWORD_RESET_HONEYPOT_FIELD } from "@/lib/security/limits";

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

let ForgotPasswordPage: typeof import("@/app/forgot-password/page").default;
let forgotMetadata: typeof import("@/app/forgot-password/page").metadata;
let ResetPasswordPage: typeof import("@/app/reset-password/page").default;
let resetMetadata: typeof import("@/app/reset-password/page").metadata;
let LoginPage: typeof import("@/app/login/page").default;

beforeAll(async () => {
  const forgotPage = await import("@/app/forgot-password/page");
  ForgotPasswordPage = forgotPage.default;
  forgotMetadata = forgotPage.metadata;
  const resetPage = await import("@/app/reset-password/page");
  ResetPasswordPage = resetPage.default;
  resetMetadata = resetPage.metadata;
  LoginPage = (await import("@/app/login/page")).default;
});

beforeEach(() => {
  searchParamsRef.current = new URLSearchParams();
});

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

describe("forgot-password page: rendered markup", () => {
  function renderForgot(): string {
    return renderToStaticMarkup(createElement(ForgotPasswordPage));
  }

  it("renders the headline and intro from the content file", () => {
    const html = renderForgot();

    expect(html).toContain(escapeHtml(FORGOT_PAGE.headline));
    expect(html).toContain(escapeHtml(FORGOT_PAGE.intro));
  });

  it("renders the public chrome (header nav and footer)", () => {
    const html = renderForgot();

    expect(html).toContain('id="public-header-nav"');
    expect(html).toContain('href="/terms"');
  });

  it("renders a labelled email field with the username autocomplete hint", () => {
    const html = renderForgot();

    // React's server renderer aliases the htmlFor prop to `for`.
    expect(html).toContain('for="email"');
    expect(html).toContain('id="email"');
    expect(html).toContain('type="email"');
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toContain(escapeHtml(FORGOT_PAGE.emailLabel));
  });

  it("renders the honeypot field hidden from users and assistive technology", () => {
    const html = renderForgot();

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('name="website"');
    expect(html).toMatch(/tabindex="-1"/i);
    expect(html).toMatch(/autocomplete="off"/i);
    // The honeypot input must sit inside the aria-hidden container.
    expect(html.indexOf('name="website"')).toBeGreaterThan(
      html.indexOf('aria-hidden="true"'),
    );
  });

  it("exposes the changing region with aria-live and renders the submit label", () => {
    const html = renderForgot();

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(escapeHtml(FORGOT_PAGE.submitLabel));
  });

  it("links back to the sign-in page", () => {
    const html = renderForgot();

    expect(html).toContain('href="/login"');
    expect(html).toContain(escapeHtml(FORGOT_PAGE.backToSignIn));
  });
});

describe("reset-password page: rendered markup", () => {
  function renderReset(): string {
    return renderToStaticMarkup(createElement(ResetPasswordPage));
  }

  it("without a token shows the invalid-link alert and a link to request a new one", () => {
    searchParamsRef.current = new URLSearchParams();
    const html = renderReset();

    expect(html).toContain('role="alert"');
    expect(html).toContain(escapeHtml(RESET_PAGE.invalidLink));
    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain(escapeHtml(RESET_PAGE.requestNewLink));
    // The password form must not render at all without a token.
    expect(html).not.toContain('id="new-password"');
  });

  it("with a token renders labelled new/confirm password fields", () => {
    searchParamsRef.current = new URLSearchParams("token=abc123");
    const html = renderReset();

    expect(html).toContain('for="new-password"');
    expect(html).toContain('id="new-password"');
    expect(html).toContain('for="confirm-password"');
    expect(html).toContain('id="confirm-password"');
    expect(html).toMatch(/autocomplete="new-password"/i);
    expect(html).toContain(escapeHtml(RESET_PAGE.newLabel));
    expect(html).toContain(escapeHtml(RESET_PAGE.confirmLabel));
  });

  it("with a token renders the requirements text linked via aria-describedby", () => {
    searchParamsRef.current = new URLSearchParams("token=abc123");
    const html = renderReset();

    expect(html).toContain('id="password-requirements"');
    expect(html).toContain(escapeHtml(RESET_PAGE.requirements));
    expect(html).toContain('aria-describedby="password-requirements"');
  });

  it("with a token starts hidden and exposes the show/hide toggle state", () => {
    searchParamsRef.current = new URLSearchParams("token=abc123");
    const html = renderReset();

    expect(html).toContain('type="password"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Show password"');
  });

  it("with a token exposes aria-live and the submit label", () => {
    searchParamsRef.current = new URLSearchParams("token=abc123");
    const html = renderReset();

    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(escapeHtml(RESET_PAGE.submitLabel));
  });
});

describe("page metadata", () => {
  it("forgot-password carries the forgot title and is noindex", () => {
    expect(forgotMetadata.title).toBe(PAGE_TITLES.forgotPassword);
    expect(String(forgotMetadata.robots)).toMatch(/\bnoindex\b/);
  });

  it("reset-password carries the reset title and is noindex", () => {
    expect(resetMetadata.title).toBe(PAGE_TITLES.resetPassword);
    expect(String(resetMetadata.robots)).toMatch(/\bnoindex\b/);
  });
});

describe("form submit contract (source-level)", () => {
  const forgotSource = readSource("components/auth/ForgotPasswordForm.tsx");
  const resetSource = readSource("components/auth/ResetPasswordForm.tsx");

  it("the request form posts email and honeypot to the request endpoint", () => {
    expect(forgotSource).toContain('fetch("/api/auth/password-reset/request", {');
    expect(forgotSource).toContain("JSON.stringify({ email, website })");
  });

  it("the honeypot literal matches the field name the server checks", () => {
    // The form cannot import the node-only limits module at runtime without
    // pulling server code into the client bundle, so the literal is mirrored;
    // this assertion keeps the two in lockstep.
    expect(PASSWORD_RESET_HONEYPOT_FIELD).toBe("website");
    expect(forgotSource).toContain('name="website"');
  });

  it("the confirm form posts the token and password to the confirm endpoint", () => {
    expect(resetSource).toContain('fetch("/api/auth/password-reset/confirm", {');
    expect(resetSource).toContain("JSON.stringify({ token, password })");
  });

  it("the confirm form reads the token from the URL and checks the match client-side", () => {
    expect(resetSource).toContain("useSearchParams");
    expect(resetSource).toContain("RESET_PAGE.mismatchError");
    expect(resetSource).toContain('id="confirm-password-error"');
  });

  it("the confirm form exposes the show/hide toggle state with aria-pressed", () => {
    expect(resetSource).toContain("aria-pressed={showPassword}");
  });

  it("both forms keep all state in React (no localStorage)", () => {
    expect(forgotSource).not.toContain("localStorage");
    expect(resetSource).not.toContain("localStorage");
  });
});

describe("design guards (source-level)", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;

  it("the new pages and forms use neither hex colours nor palette utilities", () => {
    for (const rel of [
      "app/forgot-password/page.tsx",
      "app/reset-password/page.tsx",
      "components/auth/ForgotPasswordForm.tsx",
      "components/auth/ResetPasswordForm.tsx",
    ]) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });
});

describe("sign-in page forgot-password link", () => {
  const loginSource = readSource("app/login/page.tsx");

  it("links to the reset page via FORGOT_ACCESS and no longer uses a mailto", () => {
    expect(loginSource).toContain("FORGOT_ACCESS.href");
    expect(loginSource).toContain("FORGOT_ACCESS.label");
    expect(loginSource).not.toContain("mailto:");
  });

  it("renders the forgot-password link in the login page HTML", () => {
    const html = renderToStaticMarkup(createElement(LoginPage));

    expect(html).toContain('href="/forgot-password"');
    expect(html).toContain(escapeHtml(FORGOT_ACCESS.label));
  });
});

describe("wording contract (anti-enumeration)", () => {
  it("the request success wording is generic for every submission", () => {
    // The same text is shown whether or not the email is registered, so the
    // page cannot be used to probe which addresses have accounts.
    expect(FORGOT_PAGE.successBody).toBe(
      "If an account exists for that email address, we have sent a link to reset the password. The link works once and expires in 30 minutes.",
    );
  });

  it("the invalid-link wording matches what the confirm endpoint returns", () => {
    expect(RESET_PAGE.invalidLink).toBe(
      "This reset link is invalid or has expired. Please request a new one.",
    );
  });
});
