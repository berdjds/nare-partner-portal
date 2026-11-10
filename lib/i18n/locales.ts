/**
 * Locales of the portal. English is the source and the safe fallback; Armenian is live.
 * Arabic is declared (RTL) but disabled: layouts use logical properties and `dir` comes from
 * this table, so enabling it later is a data change plus approved content, not a rewrite.
 */
export const LOCALES = {
  en: { label: "English", dir: "ltr", enabled: true },
  hy: { label: "Հայերեն", dir: "ltr", enabled: true },
  ar: { label: "العربية", dir: "rtl", enabled: false },
} as const;

export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "nare_locale";

export const enabledLocales = (): Locale[] => (Object.keys(LOCALES) as Locale[]).filter((l) => LOCALES[l].enabled);
export const dirOf = (l: Locale): "ltr" | "rtl" => LOCALES[l].dir;

/** Accepts a cookie value, query value or Accept-Language-like tag; anything else is English. */
export function resolveLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const base = String(input).trim().toLowerCase().split(/[-_]/)[0];
  return (enabledLocales() as string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE;
}
