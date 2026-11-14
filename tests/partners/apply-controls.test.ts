import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ZodTypeAny } from "zod";
import fixtures from "@/doc/ux-polish-1/evidence/fixtures.json";
import {
  ApplyForm,
  FILE_FIELD_NAMES,
  type FileFieldName,
} from "@/components/partners/ApplyForm";
import {
  ApplyWizard,
  STAGES,
  validateStage,
  type StageKey,
} from "@/components/partners/ApplyWizard";
import { LocaleProvider } from "@/lib/i18n/react";
import { translate } from "@/lib/i18n/messages";
import { applicationFieldsSchema } from "@/lib/partners/validation";
import { PARTNER_APPLY } from "@/lib/portal-content";

const FORM_TOKEN = "1234567890.abcdef";
const SHARED_CONTROL_CLASSES = [
  "h-11",
  "border",
  "border-input",
  "rounded-xl",
  "focus-visible:ring-2",
  "focus-visible:ring-ring",
  "focus-visible:ring-offset-1",
] as const;
const LOCALES = ["en", "hy"] as const;
type TestLocale = (typeof LOCALES)[number];

const NO_FILES: Record<FileFieldName, File | null> = {
  licenceFile: null,
  signatoryIdFile: null,
  otherFile: null,
};

const wizardSource = readFileSync(
  resolve(process.cwd(), "components/partners/ApplyWizard.tsx"),
  "utf8",
);

function renderWizard(locale: TestLocale = "en"): string {
  const wizard = createElement(ApplyWizard, { formToken: FORM_TOKEN });
  return renderToStaticMarkup(
    locale === "en"
      ? wizard
      : createElement(LocaleProvider, { locale, children: wizard }),
  );
}

function renderApplyForm(): string {
  return renderToStaticMarkup(createElement(ApplyForm, { formToken: FORM_TOKEN }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function extract(markup: string, pattern: RegExp, description: string): string {
  const match = markup.match(pattern);
  expect(match, `expected ${description}`).not.toBeNull();
  return match![0];
}

function openingTag(markup: string): string {
  return extract(markup, /^<[^>]+>/, "an opening tag");
}

function attribute(tag: string, name: string): string | null {
  return tag.match(new RegExp(`\\s${escapeRegExp(name)}="([^"]*)"`, "i"))?.[1] ?? null;
}

function classes(markup: string): string[] {
  return attribute(openingTag(markup), "class")?.split(/\s+/).filter(Boolean) ?? [];
}

function controlById(html: string, id: string, tag = "input"): string {
  return extract(
    html,
    new RegExp(`<${tag}\\b(?=[^>]*\\bid="${escapeRegExp(id)}")[^>]*>`, "i"),
    `${tag}#${id}`,
  );
}

function elementById(html: string, tag: string, id: string): string {
  return extract(
    html,
    new RegExp(
      `<${tag}\\b(?=[^>]*\\bid="${escapeRegExp(id)}")[^>]*>[\\s\\S]*?</${tag}>`,
      "i",
    ),
    `${tag}#${id}`,
  );
}

function stageSection(html: string, key: StageKey): string {
  return extract(
    html,
    new RegExp(
      `<section\\b(?=[^>]*\\baria-labelledby="stage-${key}-heading")[^>]*>[\\s\\S]*?</section>`,
    ),
    `the ${key} stage`,
  );
}

function labelsIn(markup: string): string[] {
  return markup.match(/<label\b[^>]*>[\s\S]*?<\/label>/gi) ?? [];
}

function expectVisibleLabel(html: string, id: string, text: string): void {
  const label = extract(
    html,
    new RegExp(
      `<label\\b(?=[^>]*\\bfor="${escapeRegExp(id)}")[^>]*>[\\s\\S]*?</label>`,
      "i",
    ),
    `a label for ${id}`,
  );
  expect(classes(label), id).not.toContain("hidden");
  expect(classes(label), id).not.toContain("sr-only");
  expect(attribute(openingTag(label), "aria-hidden"), id).not.toBe("true");
  expect(label, id).toContain(escapeHtml(text));
}

function expectSharedControlClasses(tag: string): void {
  expect(classes(tag)).toEqual(expect.arrayContaining([...SHARED_CONTROL_CLASSES]));
}

function chooseText(locale: TestLocale, name: FileFieldName): string {
  return translate("partnerApply.chooseFile", locale, {
    document: PARTNER_APPLY.labels[name],
  });
}

function hasRequiredAsterisk(label: string): boolean {
  return /<span\b(?=[^>]*\baria-hidden="true")[^>]*>\s*\*\s*<\/span>/i.test(label);
}

function sourceButton(source: string, idExpression: string): string {
  const idIndex = source.indexOf(idExpression);
  if (idIndex < 0) throw new Error(`missing source button ${idExpression}`);
  const start = source.lastIndexOf("<button", idIndex);
  const end = source.indexOf("</button>", idIndex);
  if (start < 0 || end < 0) throw new Error(`incomplete source button ${idExpression}`);
  return source.slice(start, end + "</button>".length);
}

describe("apply-ctrl shared control presentation and labels", () => {
  it("gives the wizard phone, country and Choose controls the shared text-input styling", () => {
    const html = renderWizard();

    expectSharedControlClasses(controlById(html, "contactPhone"));
    expectSharedControlClasses(controlById(html, "country", "select"));

    for (const name of FILE_FIELD_NAMES) {
      const choose = elementById(html, "button", `${name}-choose`);
      expectSharedControlClasses(choose);
      expect(choose).toContain(escapeHtml(chooseText("en", name)));
      expect(choose).toContain(escapeHtml(PARTNER_APPLY.labels[name]));
    }
  });

  it("gives all three legacy native file inputs the same styling and document-specific names", () => {
    const html = renderApplyForm();

    for (const name of FILE_FIELD_NAMES) {
      const input = controlById(html, name);
      expect(attribute(input, "type")).toBe("file");
      expectSharedControlClasses(input);
      expect(attribute(input, "aria-label")).toBe(escapeHtml(chooseText("en", name)));
      expect(attribute(input, "aria-label")).toContain(escapeHtml(PARTNER_APPLY.labels[name]));
    }
  });

  it("associates every phone, select and file control with a visible label", () => {
    const wizard = renderWizard();
    for (const name of [
      "contactPhone",
      "secondContactPhone",
      "country",
      ...FILE_FIELD_NAMES,
    ] as const) {
      expectVisibleLabel(wizard, name, PARTNER_APPLY.labels[name]);
    }

    const form = renderApplyForm();
    for (const name of ["contactPhone", "secondContactPhone", ...FILE_FIELD_NAMES] as const) {
      expectVisibleLabel(form, name, PARTNER_APPLY.labels[name]);
    }
  });

  it("keeps Replace out of initial SSR and pins its native, styled, document-specific source", () => {
    const html = renderWizard();
    expect(html).not.toContain(escapeHtml(PARTNER_APPLY.replaceFileLabel));

    for (const name of FILE_FIELD_NAMES) {
      expect(html).not.toContain(`${name}-replace`);
    }

    const replace = sourceButton(wizardSource, 'id={`${name}-replace`}');
    expect(replace).toContain('type="button"');
    expect(replace).toContain("className={`${controlClass}");
    expect(replace).toContain(
      "{PARTNER_APPLY.replaceFileLabel} {PARTNER_APPLY.labels[name]}",
    );
  });
});

describe("apply-ctrl localized phone guidance", () => {
  it.each(LOCALES)("renders %s helper text without a separate dial-code control", (locale) => {
    const html = renderWizard(locale);
    const helper = elementById(html, "p", "contactPhone-helper");
    const example = translate("partnerApply.contactPhoneExample", locale);

    expect(helper).toContain(escapeHtml(PARTNER_APPLY.contactPhoneHelper));
    expect(example).toContain("+374 91 000000");
    expect(helper).toContain(escapeHtml(example));
    expect(attribute(controlById(html, "contactPhone"), "aria-describedby")?.split(/\s+/)).toContain(
      "contactPhone-helper",
    );

    const selects = html.match(/<select\b[^>]*>/gi) ?? [];
    expect(selects).toHaveLength(1);
    expect(attribute(selects[0]!, "id")).toBe("country");
    expect(html).not.toMatch(
      /(?:id|name|aria-label)="[^"]*(?:dial(?:ing)?[-_ ]?code|country[-_ ]?code|phone[-_ ]?code)[^"]*"/i,
    );
  });
});

describe("apply-ctrl required markers", () => {
  it.each(LOCALES)("derives and renders the exact required set for every %s stage", (locale) => {
    const html = renderWizard(locale);
    const shape = applicationFieldsSchema.shape as Record<string, ZodTypeAny>;
    const requiredText = translate("partnerApply.required", locale);
    const requiredPattern = new RegExp(
      `<span\\b(?=[^>]*\\bclass="[^"]*\\bsr-only\\b[^"]*")[^>]*>\\s*\\(${escapeRegExp(escapeHtml(requiredText))}\\)\\s*</span>`,
      "i",
    );

    for (const stage of STAGES) {
      const section = stageSection(html, stage.key);
      const fields = stage.key === "review"
        ? ["consentKyc", "consentChannels"]
        : stage.fields;
      const expected = new Set(
        fields.filter((field) => shape[field]?.safeParse("").success === false),
      );
      if (stage.key === "licence") expected.add("licenceFile");

      const labels = labelsIn(section);
      const marked = new Set<string>();
      for (const label of labels) {
        const id = attribute(openingTag(label), "for");
        expect(id, "every stage label has a for attribute").not.toBeNull();
        if (hasRequiredAsterisk(label)) {
          marked.add(id!);
          expect(label, `${stage.key}.${id} localized screen-reader marker`).toMatch(requiredPattern);
        } else {
          expect(expected.has(id!), `${stage.key}.${id} is optional and unmarked`).toBe(false);
        }
      }

      expect(Array.from(marked).sort(), `${stage.key} marked fields`).toEqual(
        Array.from(expected).sort(),
      );
      const legend = escapeHtml(translate("partnerApply.requiredLegend", locale));
      expect(section.split(legend).length - 1, `${stage.key} required legend`).toBe(1);
    }
  });
});

describe("apply-ctrl typed phone FormData contract", () => {
  it("preserves the fixture through FormData and accepts the valid contacts fixture", () => {
    expect(wizardSource).toContain("new FormData(event.currentTarget)");
    expect(wizardSource).toContain(
      'onChange={(event) => setValue("contactPhone", event.target.value)}',
    );
    expect(wizardSource).not.toMatch(/data\.set\(\s*["']contactPhone["']/);

    const phone = fixtures.contacts.valid.contactPhone;
    const data = new FormData();
    data.append("contactPhone", phone);
    expect(data.get("contactPhone")).toBe(phone);

    expect(validateStage("contacts", fixtures.contacts.valid, NO_FILES)).toEqual({});
  });
});

describe("apply-ctrl keyboard semantics", () => {
  it("keeps all in-stage applicant controls in native tab order", () => {
    const html = renderWizard();

    for (const stage of STAGES) {
      const controls = stageSection(html, stage.key).match(
        /<(?:input|select|textarea|button)\b[^>]*>/gi,
      ) ?? [];
      expect(controls.length, `${stage.key} has applicant controls`).toBeGreaterThan(0);
      for (const control of controls) {
        const tabindex = attribute(control, "tabindex");
        expect(
          tabindex === null || tabindex === "0",
          `${stage.key} control has no negative or positive tabindex: ${control}`,
        ).toBe(true);
      }
    }

    for (const name of FILE_FIELD_NAMES) {
      const input = controlById(html, name);
      expect(attribute(input, "type")).toBe("file");
      expect(classes(input)).toContain("hidden");
      expect(attribute(input, "tabindex")).toBeNull();

      const choose = elementById(html, "button", `${name}-choose`);
      expect(attribute(openingTag(choose), "type")).toBe("button");
      expect(attribute(openingTag(choose), "tabindex")).toBeNull();
    }
  });

  it("uses native Choose buttons whose click delegates to the native file input", () => {
    const choose = sourceButton(wizardSource, 'id={`${name}-choose`}');
    expect(choose).toContain('type="button"');
    expect(choose).not.toMatch(/\btabIndex\s*=/);
    expect(choose).toContain("onClick={() => document.getElementById(name)?.click()}");
    expect(choose).not.toMatch(
      /\bon(?:KeyDown|KeyUp|MouseDown|MouseUp|PointerDown|PointerUp|TouchStart|TouchEnd)\s*=/,
    );
  });

  it("does not remove legacy native file inputs from keyboard order", () => {
    const html = renderApplyForm();
    for (const name of FILE_FIELD_NAMES) {
      expect(attribute(controlById(html, name), "tabindex")).not.toBe("-1");
    }
  });
});
