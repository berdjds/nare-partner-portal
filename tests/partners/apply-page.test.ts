/**
 * Public partner application page tests (W5b, staged wizard in W5f) —
 * app/partners/apply/page.tsx and components/partners/ApplyWizard.tsx.
 *
 * Contract under test:
 *
 * - The page is public (allow-listed in tests/ui/design-guard.test.ts), brands
 *   itself like the landing page, mints the signed form token via
 *   issueFormToken (lib/partners/abuse.ts), and renders ApplyWizard with it.
 *   When the token cannot be minted (NEXTAUTH_SECRET unset) the page fails
 *   closed: PARTNER_APPLY.unavailable with role="alert" and the contact
 *   mailto, never a form whose submissions can never pass.
 * - The wizard renders four stages (company, trade licence, contacts, review)
 *   whose sections all stay mounted — inactive ones carry the hidden
 *   attribute — so the initial static markup contains every field. The
 *   stepper (nav aria-label = progressLabel) marks the current stage with
 *   aria-current="step" and shows "Step 1 of 4".
 * - The rendered form carries the abuse tripwires as inert inputs: the hidden
 *   formToken (`<digits>.<64 hex>`), the hidden consentVersion
 *   (CONSENT_VERSION), and the honeypot `companyFax` — invisible (container
 *   class "hidden", aria-hidden), skipped by keyboard (tabindex -1) and not
 *   autocompleted. ApplyForm.tsx owns the HONEYPOT_FIELD_NAME export and the
 *   wizard references it; these tests tie the name to the real
 *   HONEYPOT_FIELD in lib/partners/abuse.ts (node-only).
 * - Accessibility: required fields carry the required attribute, labels are
 *   associated via for=, the single (consent) fieldset has a legend, input
 *   types are date/email/tel/file with the PDF/JPG/PNG accept list, the
 *   country select offers the Main markets / All countries optgroups, the
 *   city input feeds off the city-suggestions datalist, and both consent
 *   checkboxes are required with value="true" and link to /terms and
 *   /privacy.
 * - ApplySuccess (still exported from ApplyForm) shows the reference with
 *   role="status" and the contact mailto. Metadata: PAGE_TITLES.partnerApply
 *   and robotsDirective().
 *
 * The page and wizard render in their initial state only — stage navigation,
 * the submit path (fetch POST to /api/partners/applications, ZodIssue-array
 * mapping, client file checks, submitting state) and the file replace rows
 * run only in a browser and are pinned by source-level guards, as in
 * tests/ui/login-page.test.ts. NEXTAUTH_SECRET is set before the page module
 * is imported dynamically (issueFormToken throws without it), mirroring
 * tests/partners/apply-api.test.ts. Vitest only picks up *.test.ts, so
 * elements are built with createElement instead of JSX.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTACT,
  INDEXABLE,
  PAGE_TITLES,
  PARTNER_APPLY,
  PRODUCT_NAME,
  robotsDirective,
} from "@/lib/portal-content";
import { CONSENT_VERSION } from "@/lib/partners/validation";
import { HONEYPOT_FIELD, verifyFormToken } from "@/lib/partners/abuse";
import { Hero } from "@/components/landing/Hero";

// lib/partners/abuse.ts fails closed when NEXTAUTH_SECRET is unset (it signs
// the form token), so the page needs one — set before the page module loads.
process.env.NEXTAUTH_SECRET = String("apply-page-test-secret-min-32-characters!");

let PartnerApplyPage: typeof import("@/app/partners/apply/page").default;
let pageMetadata: typeof import("@/app/partners/apply/page").metadata;
let ApplySuccess: typeof import("@/components/partners/ApplyForm").ApplySuccess;

beforeAll(async () => {
  const page = await import("@/app/partners/apply/page");
  PartnerApplyPage = page.default;
  pageMetadata = page.metadata;
  const form = await import("@/components/partners/ApplyForm");
  ApplySuccess = form.ApplySuccess;
});

function renderApplyPage(): string {
  return renderToStaticMarkup(createElement(PartnerApplyPage));
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

/** The full rendered input/textarea/select tag for a field name, failing if absent. */
function fieldTag(html: string, name: string): string {
  const match = html.match(new RegExp(`<(?:input|textarea|select)[^>]*\\bname="${name}"[^>]*>`));
  expect(match, `expected a rendered field named ${name}`).not.toBeNull();
  return match![0];
}

describe("rendered markup", () => {
  it("renders the headline, intro, the four stage names and the form copy from the content file", () => {
    const html = renderApplyPage();

    for (const copy of [
      PRODUCT_NAME,
      PARTNER_APPLY.headline,
      PARTNER_APPLY.intro,
      // The four stage names appear in the stepper (the signatory section is
      // gone; its file fields moved into the licence stage).
      PARTNER_APPLY.sections.company,
      PARTNER_APPLY.sections.licence,
      PARTNER_APPLY.sections.contacts,
      PARTNER_APPLY.sections.review,
      PARTNER_APPLY.sections.consent,
      PARTNER_APPLY.labels.consentKyc,
      PARTNER_APPLY.labels.consentChannels,
      PARTNER_APPLY.labels.signatoryIdFile,
      PARTNER_APPLY.labels.otherFile,
      PARTNER_APPLY.submitLabel,
      PARTNER_APPLY.fileRules,
    ]) {
      expect(html).toContain(escapeHtml(copy));
    }
  });

  it("shows no error and no success state before any interaction", () => {
    const html = renderApplyPage();

    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain(escapeHtml(PARTNER_APPLY.successTitle));
    expect(html).not.toContain(escapeHtml(PARTNER_APPLY.submittingLabel));
    // The form starts idle.
    expect(html).toContain('aria-busy="false"');
  });
});

describe("staged wizard structure", () => {
  it("renders the stepper with the progress label, the current step and the step text", () => {
    const html = renderApplyPage();

    expect(html).toContain(`<nav aria-label="${escapeHtml(PARTNER_APPLY.progressLabel)}"`);
    expect(html).toContain('aria-current="step"');
    const stepText = PARTNER_APPLY.stepLabel.replace("{step}", "1").replace("{total}", "4");
    expect(stepText).toBe("Step 1 of 4");
    expect(html).toContain(escapeHtml(stepText));
  });

  it("renders the country select with both optgroups and the city datalist hook", () => {
    const html = renderApplyPage();

    const select = html.match(/<select[^>]*\bname="country"[^>]*>/);
    expect(select, "country select").not.toBeNull();
    expect(select![0]).toContain('required=""');
    expect(select![0]).toMatch(/autocomplete="country-name"/i);
    expect(html).toContain('<optgroup label="Main markets">');
    expect(html).toContain('<optgroup label="All countries">');
    expect(html).toContain('list="city-suggestions"');
    expect(html).toContain('<datalist id="city-suggestions">');
  });

  it("renders the three review Edit buttons with per-section aria labels", () => {
    const html = renderApplyPage();

    for (const key of ["company", "licence", "contacts"] as const) {
      expect(html).toContain(
        `aria-label="${escapeHtml(`${PARTNER_APPLY.editLabel} ${PARTNER_APPLY.sections[key]}`)}"`,
      );
    }
  });

  it("links both consent labels to the terms and privacy pages in a new tab", () => {
    const html = renderApplyPage();

    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });
});

describe("abuse tripwires in the rendered form", () => {
  it("embeds a hidden formToken that matches the issueFormToken format and verifies", () => {
    const html = renderApplyPage();

    const match = html.match(/<input type="hidden" name="formToken" value="([^"]+)"/);
    expect(match, "hidden formToken input").not.toBeNull();
    const token = match![1];
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/);
    // Issued just now; verify with a clock beyond MIN_FILL_MS (3 s).
    expect(verifyFormToken(token, Date.now() + 60_000)).toEqual({ ok: true });
  });

  it("embeds the current consent version as a hidden input", () => {
    const html = renderApplyPage();

    expect(html).toContain(`<input type="hidden" name="consentVersion" value="${CONSENT_VERSION}"/>`);
  });

  it("renders the honeypot invisibly, off the tab order and without autocomplete", () => {
    const html = renderApplyPage();

    // The honeypot name lives in ApplyForm.tsx as HONEYPOT_FIELD_NAME because
    // lib/partners/abuse.ts is node-only; the wizard renders that export.
    // This ties the client-side name to the real HONEYPOT_FIELD.
    expect(HONEYPOT_FIELD).toBe("companyFax");
    expect(readSource("components/partners/ApplyForm.tsx")).toContain(
      `HONEYPOT_FIELD_NAME = "${HONEYPOT_FIELD}"`,
    );
    expect(readSource("components/partners/ApplyWizard.tsx")).toContain("HONEYPOT_FIELD_NAME");

    const tag = fieldTag(html, HONEYPOT_FIELD);
    expect(tag).toContain('type="text"');
    expect(tag).toContain('tabindex="-1"');
    expect(tag).toMatch(/autocomplete="off"/i);
    expect(tag).not.toContain("required");
    // Invisible to humans: wrapped in a hidden, aria-hidden container.
    expect(html).toContain(`<div class="hidden" aria-hidden="true">`);
  });
});

describe("consent checkboxes", () => {
  it("renders consentKyc and consentChannels as required checkboxes with value true", () => {
    const html = renderApplyPage();

    for (const name of ["consentKyc", "consentChannels"]) {
      const tag = fieldTag(html, name);
      expect(tag, name).toContain('type="checkbox"');
      expect(tag, name).toContain('value="true"');
      expect(tag, name).toContain('required=""');
    }
  });
});

describe("accessibility of the rendered form", () => {
  // All stages stay mounted, so every field renders even though only the
  // company stage is visible initially.
  const REQUIRED_FIELDS = [
    "companyLegalName",
    "country",
    "city",
    "address",
    "licenceNumber",
    "licenceAuthority",
    "licenceExpiry",
    "contactName",
    "contactEmail",
    "contactPhone",
    "licenceFile",
  ];

  it("marks every required field with the required attribute", () => {
    const html = renderApplyPage();

    for (const name of REQUIRED_FIELDS) {
      expect(fieldTag(html, name), name).toContain('required=""');
    }
  });

  it("associates a label with every required field and the honeypot", () => {
    const html = renderApplyPage();

    for (const name of [...REQUIRED_FIELDS, HONEYPOT_FIELD]) {
      // React renders the Label htmlFor prop as the for attribute.
      expect(html, name).toContain(`for="${name}"`);
    }
  });

  it("groups only the consent checkboxes with fieldset and legend", () => {
    const html = renderApplyPage();

    // The wizard uses stage <section>s instead of per-section fieldsets; the
    // consent block on the review stage is the one remaining fieldset.
    expect(html.match(/<fieldset/g) ?? []).toHaveLength(1);
    expect(html.match(/<legend/g) ?? []).toHaveLength(1);
  });

  it("uses the semantic input types: date, email, tel", () => {
    const html = renderApplyPage();

    expect(fieldTag(html, "licenceExpiry")).toContain('type="date"');
    expect(fieldTag(html, "contactEmail")).toContain('type="email"');
    expect(fieldTag(html, "contactPhone")).toContain('type="tel"');
  });

  it("restricts file inputs to PDF/JPG/PNG and requires only the licence file", () => {
    const html = renderApplyPage();

    for (const name of ["licenceFile", "signatoryIdFile", "otherFile"]) {
      const tag = fieldTag(html, name);
      expect(tag, name).toContain('type="file"');
      expect(tag, name).toContain('accept=".pdf,.jpg,.jpeg,.png"');
    }
    expect(fieldTag(html, "licenceFile")).toContain('required=""');
    expect(fieldTag(html, "signatoryIdFile")).not.toContain("required");
    expect(fieldTag(html, "otherFile")).not.toContain("required");
  });
});

describe("success view", () => {
  it("renders the reference, the success copy and the contact mailto with role=status", () => {
    const reference = "PA-2026-0001";
    const html = renderToStaticMarkup(createElement(ApplySuccess, { reference }));

    expect(html).toContain('role="status"');
    expect(html).toContain(reference);
    expect(html).toContain(escapeHtml(PARTNER_APPLY.successTitle));
    expect(html).toContain(escapeHtml(PARTNER_APPLY.successReferenceLabel));
    expect(html).toContain(escapeHtml(PARTNER_APPLY.successBody));
    expect(html).toContain(`href="mailto:${CONTACT.email}"`);
  });
});

describe("fail-closed fallback", () => {
  it("renders the unavailable notice instead of the form when the token cannot be minted", () => {
    const saved = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      const html = renderApplyPage();

      expect(html).toContain('role="alert"');
      expect(html).toContain(escapeHtml(PARTNER_APPLY.unavailable));
      expect(html).toContain(`href="mailto:${CONTACT.email}"`);
      expect(html).not.toContain('name="formToken"');
      expect(html).not.toContain("<form");
    } finally {
      process.env.NEXTAUTH_SECRET = saved;
    }
  });
});

describe("metadata", () => {
  it("carries the partner-apply title and the shared robots directive", () => {
    expect(pageMetadata.title).toBe(PAGE_TITLES.partnerApply);
    expect(pageMetadata.robots).toBe(robotsDirective());
    // "noindex" contains the substring "index", so a bare /index/ match would
    // false-positive; assert the standalone directive instead.
    if (!INDEXABLE) {
      expect(String(pageMetadata.robots)).toMatch(/\bnoindex\b/);
      expect(String(pageMetadata.robots)).not.toMatch(/(^|,\s*)index\b/);
    }
  });
});

describe("submit and error handling contract (source-level)", () => {
  const wizardSource = readSource("components/partners/ApplyWizard.tsx");
  const formSource = readSource("components/partners/ApplyForm.tsx");
  const pageSource = readSource("app/partners/apply/page.tsx");

  it("posts the multipart FormData to the applications endpoint", () => {
    expect(wizardSource).toContain("new FormData(event.currentTarget)");
    expect(wizardSource).toContain(
      'fetch("/api/partners/applications", { method: "POST", body: data })',
    );
    // File inputs cannot be repopulated, so the chosen Files live in state
    // and are appended explicitly at submit time.
    expect(wizardSource).toContain("data.set(name, file)");
  });

  it("keeps the client-side file checks in ApplyForm and reuses them from the wizard", () => {
    expect(formSource).toContain("10 * 1024 * 1024");
    expect(formSource).toContain('[".pdf", ".jpg", ".jpeg", ".png"]');
    expect(wizardSource).toContain("validateUpload");
    expect(wizardSource).toContain("isPresentFile");
    expect(wizardSource).toMatch(/from "\.\/ApplyForm"/);
  });

  it("maps ZodIssue-array error responses onto the matching fields", () => {
    expect(wizardSource).toContain("Array.isArray(body.error)");
    expect(wizardSource).toContain("issue.path");
    expect(wizardSource).toContain("setFieldErrors(next)");
  });

  it("shows the form-level error with role=alert", () => {
    expect(wizardSource).toContain('role="alert"');
    expect(wizardSource).toContain("{formError}");
  });

  it("disables the submit button and shows the submitting label while sending", () => {
    expect(wizardSource).toContain("disabled={submitting}");
    expect(wizardSource).toContain("PARTNER_APPLY.submittingLabel");
  });

  it("fails closed when the form token cannot be issued", () => {
    expect(pageSource).toContain("issueFormToken()");
    expect(pageSource).toContain("try {");
    expect(pageSource).toContain("catch");
    expect(pageSource).toContain("PARTNER_APPLY.unavailable");
    expect(pageSource).toContain('role="alert"');
  });

  it("does not import the node-only partner modules from the client component", () => {
    // The sources mention these modules in comments explaining why the
    // literals are repeated; the guard targets actual imports only.
    expect(wizardSource).not.toMatch(/from\s+["'][^"']*lib\/partners\/kyc-storage["']/);
    expect(wizardSource).not.toMatch(/from\s+["'][^"']*lib\/partners\/abuse["']/);
  });
});

describe("design and wording guards (source-level)", () => {
  const hexColour = /#[0-9a-fA-F]{3,8}\b/;
  const paletteUtility =
    /\b(?:bg|text|border|ring|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d/;
  const PAGE_SOURCES = [
    "app/partners/apply/page.tsx",
    "components/partners/ApplyWizard.tsx",
    "components/partners/ApplyForm.tsx",
  ];

  it("the apply page, wizard and form use neither hex colours nor palette utilities", () => {
    for (const rel of PAGE_SOURCES) {
      const source = readSource(rel);
      expect(source, rel).not.toMatch(hexColour);
      expect(source, rel).not.toMatch(paletteUtility);
    }
  });

  it("all three sources take their copy from the content file", () => {
    for (const rel of PAGE_SOURCES) {
      expect(readSource(rel), rel).toMatch(/from "@\/lib\/portal-content"/);
    }
  });

  it("uses no banned wording (pricing, speed/automation, self-registration)", () => {
    const html = renderApplyPage();

    expect(html).not.toMatch(/\b(pricing?|costs?|fees?|cheap|discount)\b/i);
    expect(html).not.toMatch(/\b(instant(ly)?|automate[d]?|automation|real[- ]time|fast(est)?)\b/i);
    expect(html).not.toMatch(/\b(sign[- ]?up|register|create (an? )?account)\b/i);
  });
});

describe("allow-list and entry links", () => {
  it("the design guard allow-lists the public apply page outside the AppShell", () => {
    expect(readSource("tests/ui/design-guard.test.ts")).toContain("app/partners/apply/page.tsx");
  });

  it("the landing hero and the sign-in page link to /partners/apply with the shared link label", () => {
    for (const rel of ["components/landing/Hero.tsx", "app/login/page.tsx"]) {
      const source = readSource(rel);
      expect(source, rel).toContain('href="/partners/apply"');
      expect(source, rel).toContain("PARTNER_APPLY.linkLabel");
    }
  });

  it("the rendered hero carries the /partners/apply entry link", () => {
    const html = renderToStaticMarkup(createElement(Hero));

    expect(html).toContain('href="/partners/apply"');
    expect(html).toContain(escapeHtml(PARTNER_APPLY.linkLabel));
  });
});

describe("per-request rendering", () => {
  it("is forced dynamic so the form token is minted at request time, not at build time", () => {
    // Prerendering at build would bake in the fail-closed notice (no signing
    // secret during the image build) or a frozen, soon-expired token.
    expect(readSource("app/partners/apply/page.tsx")).toContain('export const dynamic = "force-dynamic"');
  });
});
