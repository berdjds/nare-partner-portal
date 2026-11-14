import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fixtures from "@/doc/ux-polish-1/evidence/fixtures.json";
import {
  GENERIC_SUBMIT_ERROR,
  NETWORK_ERROR,
  type FileFieldName,
} from "@/components/partners/ApplyForm";
import {
  STAGES,
  validateStage,
  type StageKey,
} from "@/components/partners/ApplyWizard";
import { en, type MessageKey } from "@/lib/i18n/messages/en";
import { hy } from "@/lib/i18n/messages/hy";
import { translate } from "@/lib/i18n/messages";
import {
  applicationFieldsSchema,
  CONSENT_VERSION,
} from "@/lib/partners/validation";

const wizardSource = readFileSync(
  resolve(process.cwd(), "components/partners/ApplyWizard.tsx"),
  "utf8",
);
const formSource = readFileSync(
  resolve(process.cwd(), "components/partners/ApplyForm.tsx"),
  "utf8",
);

const FIELD_NAMES = [
  "companyLegalName",
  "tradingName",
  "country",
  "city",
  "address",
  "website",
  "notes",
  "licenceNumber",
  "licenceAuthority",
  "licenceExpiry",
  "licenceFile",
  "signatoryIdFile",
  "otherFile",
  "contactName",
  "contactRole",
  "contactEmail",
  "contactPhone",
  "secondContactName",
  "secondContactEmail",
  "secondContactPhone",
  "consentKyc",
  "consentChannels",
] as const;

const FIELD_ERROR_KEYS = FIELD_NAMES.map(
  (field) => `partnerApply.errors.${field}` as MessageKey,
);
const ALL_ERROR_KEYS = Object.keys(en).filter((key): key is MessageKey =>
  key.startsWith("partnerApply.errors."),
);

const NO_FILES: Record<FileFieldName, File | null> = {
  licenceFile: null,
  signatoryIdFile: null,
  otherFile: null,
};

function fixtureFor(stage: StageKey, valid: boolean): Record<string, unknown> {
  const group = fixtures[stage];
  return valid ? group.valid : group.invalid;
}

function textValues(fixture: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fixture).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function filesFor(stage: StageKey, valid: boolean): Record<FileFieldName, File | null> {
  if (stage !== "licence") return NO_FILES;
  const fixtureFiles = fixtureFor(stage, valid).files as Record<
    FileFieldName,
    { name: string; type: string; size: number } | null
  >;
  return {
    licenceFile: fixtureFiles.licenceFile
      ? new File([new Uint8Array(fixtureFiles.licenceFile.size)], fixtureFiles.licenceFile.name, {
          type: fixtureFiles.licenceFile.type,
        })
      : null,
    signatoryIdFile: null,
    otherFile: null,
  };
}

function allValidValues(): Record<string, string> {
  return {
    ...textValues(fixtures.company.valid),
    ...textValues(fixtures.licence.valid),
    ...textValues(fixtures.contacts.valid),
    ...textValues(fixtures.review.valid),
    consentVersion: CONSENT_VERSION,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apply error validation timing and clearing", () => {
  it("marks edited fields touched and validates text, select and phone fields on blur only", () => {
    expect(wizardSource).toContain("const [touched, setTouched]");
    expect(wizardSource).toContain("setTouched((previous) => ({ ...previous, [name]: true }))");
    expect(wizardSource).toContain('onBlur={(event) => handleBlur(event.target.getAttribute("name") ?? "")}');
    expect(wizardSource).toContain(
      "if (touched[name] && FIELD_ERROR_KEYS[name] && !isImmediateField(name)) validateField(name);",
    );

    for (const field of STAGES.flatMap((stage) => stage.fields)) {
      expect(wizardSource, field).toContain(`onChange={(event) => setValue("${field}", event.target.value)}`);
    }
  });

  it("validates consent checkboxes and file inputs immediately on change", () => {
    const consentChange = wizardSource.match(
      /onChange=\{\(event\) => \{\s*const value = event\.target\.checked \? "true" : "";\s*setValue\(name, value\);\s*validateField\(name, \{ \.\.\.values, \[name\]: value \}\);/,
    );
    expect(consentChange, "consent change validates immediately").not.toBeNull();

    const fileChange = wizardSource.match(
      /const file = event\.target\.files\?\.\[0\] \?\? null;\s*setFile\(name, file\);\s*validateField\(name, values, \{ \.\.\.files, \[name\]: file \}\);/,
    );
    expect(fileChange, "file change validates immediately").not.toBeNull();
  });

  it("revalidates an edited field with an existing error and deletes the error when valid", () => {
    expect(wizardSource).toContain(
      "if (fieldErrors[name]) validateField(name, { ...values, [name]: value });",
    );
    expect(wizardSource).toContain("if (messageKey) next[name] = messageKey;");
    expect(wizardSource).toContain("else delete next[name];");
    expect(wizardSource).toContain("validateStage(stageForField(name), nextValues, nextFiles)");
  });
});

describe("apply error accessibility", () => {
  it("maps every field to a message key and wires its message with aria-invalid and aria-describedby", () => {
    for (const field of FIELD_NAMES) {
      expect(wizardSource, field).toContain(
        `${field}: "partnerApply.errors.${field}"`,
      );
    }
    expect(wizardSource).toContain("return `${name}-error`;");
    expect(wizardSource).toContain('"aria-invalid": fieldErrors[name] ? true : undefined');
    expect(wizardSource).toContain('"aria-describedby": describedBy || undefined');
    expect(wizardSource).toContain('<p id={errorId(name)}');
    expect(wizardSource).toContain("{t(messageKey)}");
    expect(wizardSource).not.toContain("{message}\n");
  });

  it("shows a localised alert count on Next or Submit and focuses the first visible invalid control in DOM order", () => {
    expect(wizardSource).toContain("showValidationErrors(errors);");
    expect(wizardSource).toContain("showValidationErrors(reviewErrors);");
    expect(wizardSource).toContain('role="alert"');
    expect(wizardSource).toContain(
      't("partnerApply.errors.summary", { count: Object.keys(fieldErrors).length })',
    );
    expect(wizardSource).toContain("querySelectorAll<HTMLElement>('[aria-invalid=\"true\"]')");
    expect(wizardSource).toContain('element.closest("section[hidden]") === null');
    expect(wizardSource).toContain("firstInvalid?.focus();");

    expect(translate("partnerApply.errors.summary", "en", { count: 4 })).toContain("4");
    expect(translate("partnerApply.errors.summary", "hy", { count: 4 })).toContain("4");
  });
});

describe("client/schema verdict parity", () => {
  const cases = STAGES.flatMap((stage) =>
    ([true, false] as const).map((valid) => ({ stage: stage.key, valid })),
  );

  it.each(cases)("matches applicationFieldsSchema.safeParse for the $stage $valid fixture", ({ stage, valid }) => {
    const values = { ...allValidValues(), ...textValues(fixtureFor(stage, valid)) };
    const clientValid = Object.keys(validateStage(stage, values, filesFor(stage, valid))).length === 0;
    const schemaValid = applicationFieldsSchema.safeParse(values).success;

    expect(clientValid).toBe(schemaValid);
    expect(clientValid).toBe(valid);
  });
});

describe("localised apply error catalogues", () => {
  it("provides distinct Armenian text from HY keys for every field and generic error", () => {
    expect(ALL_ERROR_KEYS).toEqual(expect.arrayContaining(FIELD_ERROR_KEYS));
    expect(ALL_ERROR_KEYS).toHaveLength(FIELD_ERROR_KEYS.length + 3);
    for (const key of ALL_ERROR_KEYS) {
      const armenian = translate(key, "hy");
      expect(armenian, key).toBe(hy[key]);
      expect(armenian, key).not.toBe(en[key]);
      expect(armenian, key).toMatch(/[\u0531-\u058f]/);
    }
  });

  it("keeps the existing generic English messages behind the new keys", () => {
    expect(en["partnerApply.errors.genericSubmit"]).toBe(GENERIC_SUBMIT_ERROR);
    expect(en["partnerApply.errors.network"]).toBe(NETWORK_ERROR);
  });

  it("uses no existence-revealing wording in any EN or HY apply error", () => {
    const forbiddenEnglish = /\b(?:exists?|already|registered|found|duplicate)\b/i;
    const forbiddenArmenian = /(?:արդեն|գրանցված|գոյություն|գտնվել|գտնված|կրկնօրինակ)/i;

    for (const key of ALL_ERROR_KEYS) {
      expect(en[key], `EN ${key}`).not.toMatch(forbiddenEnglish);
      expect(hy[key], `HY ${key}`).not.toMatch(forbiddenArmenian);
    }
  });
});

describe("server and upload failures", () => {
  it.each([400, 500])(
    "maps a stubbed %i rejection to generic localised text, never body.error, in both forms",
    async (status) => {
      const serverText = "email already registered";
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: serverText }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await fetch("/api/partners/applications", {
        method: "POST",
        body: new FormData(),
      });
      const body = await response.json();
      expect(response.ok).toBe(false);
      expect(body.error).toBe(serverText);

      for (const source of [wizardSource, formSource]) {
        expect(source).toContain("setFormError(GENERIC_SUBMIT_ERROR);");
        expect(source).not.toContain('typeof body.error === "string"');
        expect(source).not.toMatch(/setFormError\([^)]*body\.error/);
        expect(source).not.toMatch(/\.reset\s*\(/);
      }
      expect(en["partnerApply.errors.genericSubmit"]).not.toContain(serverText);
      expect(hy["partnerApply.errors.genericSubmit"]).not.toContain(serverText);
    },
  );

  it("maps a stubbed upload transport failure to NETWORK_ERROR without clearing entered values or files", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("upload failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetch("/api/partners/applications", { method: "POST", body: new FormData() }),
    ).rejects.toThrow("upload failed");

    for (const source of [wizardSource, formSource]) {
      expect(source).toContain("setFormError(NETWORK_ERROR);");
      expect(source).not.toMatch(/\.reset\s*\(/);
    }
    expect(wizardSource).not.toMatch(/setValues\s*\(\s*\{\s*\}\s*\)/);
    expect(wizardSource).not.toMatch(/setFiles\s*\(\s*\{\s*\}\s*\)/);
  });
});

describe("wizard privacy and CSP source guard", () => {
  it("uses no storage, URL writes, console output or style attributes", () => {
    expect(wizardSource).not.toContain("localStorage");
    expect(wizardSource).not.toContain("sessionStorage");
    expect(wizardSource).not.toMatch(/\bconsole\s*\./);
    expect(wizardSource).not.toMatch(/\bhistory\.(?:pushState|replaceState)\b/);
    expect(wizardSource).not.toMatch(/\b(?:window\.)?location\s*(?:=|\.href\s*=)/);
    expect(wizardSource).not.toMatch(/\sstyle\s*=/i);
  });
});
