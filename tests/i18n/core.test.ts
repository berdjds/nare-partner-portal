/** Phase 4: locale resolution, fallback, RTL readiness and catalogue completeness. */
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, dirOf, enabledLocales, resolveLocale } from "@/lib/i18n/locales";
import { MESSAGES, missingKeys, translate, placeholdersOf } from "@/lib/i18n/messages";

describe("locales", () => {
  it("English is the default and the safe fallback; Armenian is enabled; Arabic is prepared but disabled", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(enabledLocales()).toEqual(["en", "hy"]);
    expect(LOCALES.ar.enabled).toBe(false);
  });
  it("resolveLocale accepts only enabled locales (case-insensitive, region tags) and falls back to English", () => {
    expect(resolveLocale("hy")).toBe("hy");
    expect(resolveLocale("HY")).toBe("hy");
    expect(resolveLocale("hy-AM")).toBe("hy");
    expect(resolveLocale("ar")).toBe("en"); // not enabled yet
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale("<script>")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null)).toBe("en");
  });
  it("direction is data: Arabic is RTL (ready for later), the rest LTR", () => {
    expect(dirOf("ar")).toBe("rtl");
    expect(dirOf("en")).toBe("ltr");
    expect(dirOf("hy")).toBe("ltr");
  });
});

describe("translate", () => {
  it("returns the locale text, interpolates variables, and falls back to English then to the key", () => {
    expect(translate("common.signIn", "en")).toBe("Sign in");
    expect(translate("common.signIn", "hy")).not.toBe("Sign in");
    expect(translate("footer.rights", "en", { year: 2026, name: "X" })).toContain("2026");
    // A key present only in English falls back instead of showing nothing.
    const en = MESSAGES.en as Record<string, string>;
    en["test.onlyEnglish"] = "English only";
    expect(translate("test.onlyEnglish" as never, "hy")).toBe("English only");
    delete en["test.onlyEnglish"];
    expect(translate("test.unknown" as never, "hy")).toBe("test.unknown");
  });
  it("never injects markup: variables are inserted as plain text", () => {
    expect(translate("footer.rights", "en", { year: 2026, name: "<b>x</b>" })).toContain("<b>x</b>"); // escaped by React at render
  });
});

describe("catalogue completeness", () => {
  it("every English key exists in every enabled locale (the check that fails the build when a label is missing)", () => {
    for (const loc of enabledLocales()) expect(missingKeys(loc), `missing in ${loc}`).toEqual([]);
  });
  it("no locale has keys English does not know, and no empty strings", () => {
    for (const loc of enabledLocales()) {
      for (const [k, v] of Object.entries(MESSAGES[loc])) {
        expect(k in MESSAGES.en, `${loc}:${k} unknown to English`).toBe(true);
        expect(String(v).trim().length, `${loc}:${k} empty`).toBeGreaterThan(0);
      }
    }
  });
  it("placeholders match between English and every translation", () => {
    for (const loc of enabledLocales()) for (const [k, v] of Object.entries(MESSAGES[loc])) expect(placeholdersOf(String(v)), `${loc}:${k}`).toEqual(placeholdersOf((MESSAGES.en as Record<string, string>)[k]));
  });
  it("Armenian strings actually contain Armenian script (guards against pasted English)", () => {
    const hy = MESSAGES.hy as Record<string, string>;
    const armenian = (s: string) => /[Ա-֏]/.test(s);
    const exempt = new Set(["common.brand", "login.emailPlaceholder"]);
    for (const [k, v] of Object.entries(hy)) if (!exempt.has(k)) expect(armenian(v), `${k}: ${v}`).toBe(true);
  });
});

describe("English catalogue reuses the content constants (single home for English text)", () => {
  it("login and nav labels equal the portal-content values", async () => {
    const pc = await import("@/lib/portal-content");
    const { translate } = await import("@/lib/i18n/messages");
    expect(translate("login.forgot", "en")).toBe(pc.FORGOT_ACCESS.label);
    expect(translate("nav.apply", "en")).toBe(pc.PARTNER_APPLY.linkLabel);
    expect(translate("login.headline", "en")).toBe(pc.LOGIN_PANEL.headline);
  });
});

describe("Accept-Language", () => {
  it("honours the user's order and q-values, ignores refusals, and keeps English when it ranks first", async () => {
    const { pickFromAcceptLanguage: pick } = await import("@/lib/i18n/locales");
    expect(pick("en-US,en;q=0.9,hy;q=0.8")).toBe("en");
    expect(pick("hy-AM,hy;q=0.9,en;q=0.8")).toBe("hy");
    expect(pick("hy;q=0, en")).toBe("en");
    expect(pick("fr, hy;q=0.7, en;q=0.5")).toBe("hy");
    expect(pick("ar, fr;q=0.8")).toBe("en"); // ar not enabled
    expect(pick("*")).toBe("en");
    expect(pick("")).toBe("en");
    expect(pick(null)).toBe("en");
    expect(pick("hy;q=abc")).toBe("en");
  });
});
