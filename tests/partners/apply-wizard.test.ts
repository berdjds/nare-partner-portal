/**
 * Staged partner application wizard tests (W5f) —
 * components/partners/ApplyWizard.tsx.
 *
 * Contract under test:
 *
 * - The stage model: STAGES lists the four stages (company → licence →
 *   contacts → review) with the exact field names each stage validates, and
 *   every one of those field names exists in applicationFieldsSchema
 *   (lib/partners/validation.ts) — the agreement between the wizard's stage
 *   lists and the shared schema the API route enforces.
 * - validateStage is a pure, node-safe export: it runs the shared schema per
 *   stage, requires the licence file on the licence stage, reuses the shared
 *   upload checks (10 MB, PDF/JPG/PNG) and checks both consents on the review
 *   stage. It is unit-tested directly here, no DOM involved.
 * - formatFileSize renders the upload sizes for the file summary rows.
 * - The rendered markup (renderToStaticMarkup of the initial state): all four
 *   stage sections stay mounted with the inactive ones hidden, the stepper
 *   exposes aria-current="step" and "Step 1 of 4", the polite live region
 *   starts empty, the review stage carries the summary cards with Edit
 *   buttons and the consent fieldset, and the abuse tripwires (formToken,
 *   consentVersion, honeypot) are inert inputs.
 *
 * Stage navigation, focus management, the submit path and the file
 * replace/summary rows only run in a browser (node environment, no jsdom),
 * so they are pinned by source-level guards on the component, as in
 * tests/partners/apply-page.test.ts and tests/ui/login-page.test.ts. Vitest
 * only picks up *.test.ts, so elements are built with createElement instead
 * of JSX.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ZodTypeAny } from "zod";
import { PARTNER_APPLY } from "@/lib/portal-content";
import { applicationFieldsSchema, CONSENT_VERSION } from "@/lib/partners/validation";
import { TERMS_OF_USE, PRIVACY_NOTICE } from "@/lib/legal-content";
import {
  ApplyWizard,
  STAGES,
  validateStage,
  formatFileSize,
  type StageKey,
} from "@/components/partners/ApplyWizard";
import {
  FILE_FIELD_NAMES,
  FILE_INPUT_ACCEPT,
  type FileFieldName,
} from "@/components/partners/ApplyForm";

// A short dummy token — the wizard only echoes it into the hidden input.
const FORM_TOKEN = "1234567890.abcdef";

const NO_FILES: Record<FileFieldName, File | null> = {
  licenceFile: null,
  signatoryIdFile: null,
  otherFile: null,
};

function renderWizard(): string {
  return renderToStaticMarkup(createElement(ApplyWizard, { formToken: FORM_TOKEN }));
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

/** The full rendered input/textarea tag for a field name, failing if absent. */
function fieldTag(html: string, name: string): string {
  const match = html.match(new RegExp(`<(?:input|textarea)[^>]*\\bname="${name}"[^>]*>`));
  expect(match, `expected a rendered field named ${name}`).not.toBeNull();
  return match![0];
}

/**
 * The message applicationFieldsSchema produces for one field/value pair —
 * validateStage must surface exactly these messages, so the expected errors
 * are derived from the schema itself rather than repeated literals.
 */
function firstSchemaMessage(field: string, value: string): string {
  const fieldSchema = (applicationFieldsSchema.shape as Record<string, ZodTypeAny>)[field];
  expect(fieldSchema, `schema has a shape entry for ${field}`).toBeDefined();
  const result = fieldSchema.safeParse(value);
  if (result.success) {
    throw new Error(`expected the schema to reject ${field}=${JSON.stringify(value)}`);
  }
  return result.error.issues[0]?.message ?? "";
}

describe("stage model", () => {
  it("defines exactly the four stages in order", () => {
    expect(STAGES).toHaveLength(4);
    expect(STAGES.map((stage) => stage.key)).toEqual(["company", "licence", "contacts", "review"]);
  });

  it("lists the exact fields each stage validates", () => {
    const fieldsByKey = Object.fromEntries(STAGES.map((stage) => [stage.key, stage.fields]));

    expect(fieldsByKey.company).toEqual([
      "companyLegalName",
      "tradingName",
      "country",
      "city",
      "address",
      "website",
      "notes",
    ]);
    expect(fieldsByKey.licence).toEqual(["licenceNumber", "licenceAuthority", "licenceExpiry"]);
    expect(fieldsByKey.contacts).toEqual([
      "contactName",
      "contactRole",
      "contactEmail",
      "contactPhone",
      "secondContactName",
      "secondContactEmail",
      "secondContactPhone",
    ]);
    expect(fieldsByKey.review).toEqual([]);
  });

  it("only lists field names that exist in applicationFieldsSchema", () => {
    const schemaFields = Object.keys(applicationFieldsSchema.shape);

    for (const stage of STAGES) {
      for (const field of stage.fields) {
        expect(schemaFields, `${stage.key}.${field}`).toContain(field);
      }
    }
  });
});

describe("validateStage", () => {
  it("company: reports the required text fields with the schema messages", () => {
    const errors = validateStage("company", {}, NO_FILES);

    expect(errors).toEqual({
      companyLegalName: firstSchemaMessage("companyLegalName", ""),
      country: firstSchemaMessage("country", ""),
      city: firstSchemaMessage("city", ""),
      address: firstSchemaMessage("address", ""),
    });
    // Pin the exact wording so a schema copy change is a deliberate act.
    expect(errors.companyLegalName).toBe("Enter the registered company name");
    expect(errors.country).toBe("Enter the country");
  });

  it("company: accepts a complete valid stage", () => {
    const errors = validateStage(
      "company",
      {
        companyLegalName: "Ararat Travel LLC",
        country: "Armenia",
        city: "Yerevan",
        address: "1 Abovyan St, Yerevan",
      },
      NO_FILES,
    );

    expect(errors).toEqual({});
  });

  it("company: rejects a malformed website with the schema url message", () => {
    const errors = validateStage(
      "company",
      {
        companyLegalName: "Ararat Travel LLC",
        country: "Armenia",
        city: "Yerevan",
        address: "1 Abovyan St, Yerevan",
        website: "not-a-url",
      },
      NO_FILES,
    );

    expect(errors).toEqual({ website: firstSchemaMessage("website", "not-a-url") });
    expect(errors.website).toBe("Enter a full website address, e.g. https://example.com");
  });

  it("licence: requires the licence file even when the text fields are valid", () => {
    const errors = validateStage(
      "licence",
      {
        licenceNumber: "TL-123456",
        licenceAuthority: "Yerevan Municipality",
        licenceExpiry: "2027-01-15",
      },
      NO_FILES,
    );

    expect(errors).toEqual({ licenceFile: PARTNER_APPLY.licenceFileRequired });
  });

  it("licence: rejects an oversize file with the shared size message", () => {
    // A lightweight fake instead of a real 11 MB allocation.
    const bigFile = { name: "big.pdf", size: 11 * 1024 * 1024 } as File;
    const errors = validateStage(
      "licence",
      {
        licenceNumber: "TL-123456",
        licenceAuthority: "Yerevan Municipality",
        licenceExpiry: "2027-01-15",
      },
      { ...NO_FILES, licenceFile: bigFile },
    );

    expect(errors).toEqual({ licenceFile: "Files must be at most 10 MB each." });
  });

  it("licence: rejects a disallowed extension with the shared type message", () => {
    const errors = validateStage(
      "licence",
      {
        licenceNumber: "TL-123456",
        licenceAuthority: "Yerevan Municipality",
        licenceExpiry: "2027-01-15",
      },
      { ...NO_FILES, licenceFile: new File(["x"], "scan.gif") },
    );

    expect(errors).toEqual({ licenceFile: "Files must be PDF, JPG or PNG." });
  });

  it("licence: accepts valid text fields and a small PDF", () => {
    const errors = validateStage(
      "licence",
      {
        licenceNumber: "TL-123456",
        licenceAuthority: "Yerevan Municipality",
        licenceExpiry: "2027-01-15",
      },
      { ...NO_FILES, licenceFile: new File(["x"], "licence.pdf") },
    );

    expect(errors).toEqual({});
  });

  it("contacts: rejects a bad email and a bad phone with the schema messages", () => {
    const emailErrors = validateStage(
      "contacts",
      {
        contactName: "Ani Hakobyan",
        contactEmail: "not-an-email",
        contactPhone: "+37491000000",
      },
      NO_FILES,
    );
    expect(emailErrors).toEqual({ contactEmail: firstSchemaMessage("contactEmail", "not-an-email") });
    expect(emailErrors.contactEmail).toBe("Enter a valid email address");

    const phoneErrors = validateStage(
      "contacts",
      {
        contactName: "Ani Hakobyan",
        contactEmail: "ani@example.com",
        contactPhone: "abc",
      },
      NO_FILES,
    );
    expect(phoneErrors).toEqual({ contactPhone: firstSchemaMessage("contactPhone", "abc") });
    expect(phoneErrors.contactPhone).toBe(
      "Enter a phone number with 8 to 15 digits (country code included)",
    );
  });

  it("contacts: accepts a valid primary contact with the second contact left empty", () => {
    const errors = validateStage(
      "contacts",
      {
        contactName: "Ani Hakobyan",
        contactEmail: "ani@example.com",
        contactPhone: "+37491000000",
      },
      NO_FILES,
    );

    expect(errors).toEqual({});
  });

  it("review: requires both consents with the schema messages", () => {
    const errors = validateStage("review", {}, NO_FILES);

    expect(errors).toEqual({
      consentKyc: firstSchemaMessage("consentKyc", ""),
      consentChannels: firstSchemaMessage("consentChannels", ""),
    });
    expect(errors.consentKyc).toBe("Consent to KYC document processing is required");
    expect(errors.consentChannels).toBe(
      "Consent to being contacted by email and WhatsApp is required",
    );
  });

  it("review: accepts both consents given as the string true", () => {
    const errors = validateStage(
      "review",
      { consentKyc: "true", consentChannels: "true" },
      NO_FILES,
    );

    expect(errors).toEqual({});
  });
});

describe("formatFileSize", () => {
  it("renders bytes below 1 KB as-is", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("renders kilobytes rounded to a whole number", () => {
    expect(formatFileSize(2048)).toBe("2 KB");
  });

  it("renders megabytes with one decimal", () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

describe("rendered wizard markup", () => {
  it("renders the stepper: progress nav, four items, the current step and the step text", () => {
    const html = renderWizard();

    expect(html).toContain(`<nav aria-label="${escapeHtml(PARTNER_APPLY.progressLabel)}"`);
    expect(html.match(/<li[ >]/g) ?? []).toHaveLength(4);
    expect(html.match(/aria-current="step"/g) ?? []).toHaveLength(1);
    const stepText = PARTNER_APPLY.stepLabel.replace("{step}", "1").replace("{total}", "4");
    expect(stepText).toBe("Step 1 of 4");
    expect(html).toContain(escapeHtml(stepText));
  });

  it("keeps all four stage sections mounted with only the inactive ones hidden", () => {
    const html = renderWizard();

    expect(html.match(/<section[ >]/g) ?? []).toHaveLength(4);
    expect(html.match(/<section[^>]*\shidden=""/g) ?? []).toHaveLength(3);
    const companySection = html.match(/<section[^>]*aria-labelledby="stage-company-heading"[^>]*>/);
    expect(companySection, "company stage section").not.toBeNull();
    expect(companySection![0]).not.toContain("hidden");

    for (const key of ["company", "licence", "contacts", "review"] satisfies StageKey[]) {
      expect(html).toContain(`<h2 id="stage-${key}-heading" tabindex="-1"`);
    }
  });

  it("starts with an empty polite live region and no alert or status roles", () => {
    const html = renderWizard();

    const liveRegion = html.match(/<p aria-live="polite"[^>]*><\/p>/);
    expect(liveRegion, "empty polite live region").not.toBeNull();
    expect(liveRegion![0]).not.toContain("role=");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    // The form uses native-validation-free submission (hidden required
    // fields must not block it) and starts idle. React's server renderer
    // keeps the camelCase prop spelling; the HTML parser lowercases
    // attribute names, so assert case-insensitively.
    expect(html.toLowerCase()).toContain("novalidate");
    expect(html).toContain('aria-busy="false"');
  });

  it("offers Next but no Back on the first stage, with the submit button in the hidden review stage", () => {
    const html = renderWizard();

    expect(html).toContain(`>${escapeHtml(PARTNER_APPLY.nextLabel)}</button>`);
    expect(html).not.toContain(`>${escapeHtml(PARTNER_APPLY.backLabel)}</button>`);
    const submit = html.match(/<button[^>]*type="submit"[^>]*>/);
    expect(submit, "submit button").not.toBeNull();
    expect(html).toContain(escapeHtml(PARTNER_APPLY.submitLabel));
  });

  it("renders the country select with placeholder, both optgroups and the market options", () => {
    const html = renderWizard();

    const select = html.match(/<select[^>]*\bname="country"[^>]*>/);
    expect(select, "country select").not.toBeNull();
    expect(select![0]).toContain('required=""');
    expect(select![0]).toMatch(/autocomplete="country-name"/i);
    expect(html).toMatch(
      new RegExp(`<option[^>]*value=""[^>]*>${escapeHtml(PARTNER_APPLY.countryPlaceholder)}</option>`),
    );
    expect(html).toContain('<optgroup label="Main markets">');
    expect(html).toContain('<optgroup label="All countries">');
    expect(html).toContain("<option value=\"Armenia\">Armenia</option>");
    expect(html).toContain(
      "<option value=\"United Arab Emirates\">United Arab Emirates</option>",
    );
  });

  it("renders the city input with the suggestions datalist, initially empty", () => {
    const html = renderWizard();

    expect(fieldTag(html, "city")).toContain('list="city-suggestions"');
    // No country is chosen yet, so there are no suggestions.
    expect(html).toContain('<datalist id="city-suggestions"></datalist>');
  });

  it("renders the three file inputs with the shared accept and only the licence required", () => {
    const html = renderWizard();

    expect(FILE_FIELD_NAMES).toEqual(["licenceFile", "signatoryIdFile", "otherFile"]);
    expect(FILE_INPUT_ACCEPT).toBe(".pdf,.jpg,.jpeg,.png");
    for (const name of FILE_FIELD_NAMES) {
      const tag = fieldTag(html, name);
      expect(tag, name).toContain('type="file"');
      expect(tag, name).toContain(`accept="${FILE_INPUT_ACCEPT}"`);
    }
    expect(fieldTag(html, "licenceFile")).toContain('required=""');
    expect(fieldTag(html, "signatoryIdFile")).not.toContain("required");
    expect(fieldTag(html, "otherFile")).not.toContain("required");
  });

  it("renders the review stage: helper, summary cards with Edit buttons and notProvided rows", () => {
    const html = renderWizard();

    expect(html).toContain(escapeHtml(PARTNER_APPLY.reviewHelper));
    for (const [key, label] of [
      ["company", "Edit Company"],
      ["licence", "Edit Trade licence"],
      ["contacts", "Edit Contacts"],
    ] as const) {
      const expected = `${PARTNER_APPLY.editLabel} ${PARTNER_APPLY.sections[key]}`;
      expect(expected).toBe(label);
      expect(html).toContain(`aria-label="${escapeHtml(expected)}"`);
    }
    expect(html).toContain("<dl");
    expect(html).toContain("<dt");
    expect(html).toContain("<dd");
    // Every entry starts empty, so the summary rows show the placeholder.
    expect(html).toContain(escapeHtml(PARTNER_APPLY.notProvided));
  });

  it("renders the consent fieldset with required checkboxes linking to the legal pages", () => {
    const html = renderWizard();

    expect(html.match(/<fieldset/g) ?? []).toHaveLength(1);
    expect(html).toContain(escapeHtml(PARTNER_APPLY.sections.consent));
    for (const name of ["consentKyc", "consentChannels"]) {
      const tag = fieldTag(html, name);
      expect(tag, name).toContain('type="checkbox"');
      expect(tag, name).toContain('value="true"');
      expect(tag, name).toContain('required=""');
    }
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain(escapeHtml(TERMS_OF_USE.title));
    expect(html).toContain(escapeHtml(PRIVACY_NOTICE.title));
  });

  it("embeds the abuse tripwires as inert inputs", () => {
    const html = renderWizard();

    expect(html).toContain(`<input type="hidden" name="formToken" value="${FORM_TOKEN}"/>`);
    expect(html).toContain(`<input type="hidden" name="consentVersion" value="${CONSENT_VERSION}"/>`);
    const honeypot = fieldTag(html, "companyFax");
    expect(honeypot).toContain('type="text"');
    expect(honeypot).toContain('tabindex="-1"');
    expect(honeypot).toMatch(/autocomplete="off"/i);
    expect(honeypot).not.toContain("required");
    expect(html).toContain('<div class="hidden" aria-hidden="true">');
  });
});

describe("wizard source guards", () => {
  const wizardSource = readSource("components/partners/ApplyWizard.tsx");

  it("imports the shared client-safe modules", () => {
    expect(wizardSource).toContain("COUNTRIES");
    expect(wizardSource).toContain("getCitySuggestions");
    expect(wizardSource).toContain('from "@/lib/partners/locations"');
    expect(wizardSource).toContain("applicationFieldsSchema");
    expect(wizardSource).toContain("CONSENT_VERSION");
    expect(wizardSource).toContain('from "@/lib/partners/validation"');
    expect(wizardSource).toContain("TERMS_OF_USE");
    expect(wizardSource).toContain("PRIVACY_NOTICE");
    expect(wizardSource).toContain('from "@/lib/legal-content"');
    for (const piece of [
      "ApplySuccess",
      "FILE_FIELD_NAMES",
      "FILE_INPUT_ACCEPT",
      "GENERIC_SUBMIT_ERROR",
      "HONEYPOT_FIELD_NAME",
      "NETWORK_ERROR",
      "isPresentFile",
      "validateUpload",
    ]) {
      expect(wizardSource).toContain(piece);
    }
    expect(wizardSource).toContain('from "./ApplyForm"');
  });

  it("does not import the node-only partner modules", () => {
    // The sources mention these modules in comments explaining why the
    // literals are repeated; the guard targets actual imports only.
    expect(wizardSource).not.toMatch(/from\s+["'][^"']*lib\/partners\/kyc-storage["']/);
    expect(wizardSource).not.toMatch(/from\s+["'][^"']*lib\/partners\/abuse["']/);
  });

  it("wires per-stage validation with accessible error reporting", () => {
    expect(wizardSource).toContain("validateStage(");
    expect(wizardSource).toContain("aria-invalid");
    expect(wizardSource).toContain("aria-describedby");
    expect(wizardSource).toContain("-error");
    // Stage changes move focus to the stage heading.
    expect(wizardSource).toContain("focus(");
    expect(wizardSource).toContain('aria-live="polite"');
    // Native constraint validation must stay off: required fields are hidden
    // on every stage but the last, and would block submission.
    expect(wizardSource).toContain("noValidate");
  });

  it("persists nothing to web storage and never navigates via window.location", () => {
    // Usage-targeted: the header comment mentions the storage names when
    // stating this rule, so a bare substring check would false-positive.
    expect(wizardSource).not.toMatch(/\blocalStorage\s*[.[]/);
    expect(wizardSource).not.toMatch(/\bsessionStorage\s*[.[]/);
    expect(wizardSource).not.toMatch(/window\.location\s*(?:=|\.href\s*=)/);
  });

  it("keeps the submit contract: FormData of the form, files appended, one POST", () => {
    expect(wizardSource).toContain("new FormData(event.currentTarget)");
    expect(wizardSource).toContain(
      'fetch("/api/partners/applications", { method: "POST", body: data })',
    );
    expect(wizardSource).toContain("data.set(name, file)");
  });

  it("keeps the file replace/summary UX wired to the shared content and helper", () => {
    expect(wizardSource).toContain("PARTNER_APPLY.replaceFileLabel");
    expect(wizardSource).toContain("formatFileSize(");
  });

  it("uses no banned wording (pricing, speed/automation, self-registration)", () => {
    const html = renderWizard();

    expect(html).not.toMatch(/\b(pricing?|costs?|fees?|cheap|discount)\b/i);
    expect(html).not.toMatch(/\b(instant(ly)?|automate[d]?|automation|real[- ]time|fast(est)?)\b/i);
    expect(html).not.toMatch(/\b(sign[- ]?up|register|create (an? )?account)\b/i);
  });
});
