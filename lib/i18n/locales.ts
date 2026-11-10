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

/**
 * Picks the first ENABLED locale from an Accept-Language header, honouring the user's own
 * order (q-values, q=0 = refused). An English entry ahead of Armenian therefore keeps English.
 */
export function pickFromAcceptLanguage(header: string | null | undefined): Locale {
  const entries = String(header ?? "").split(",").map((part, index) => {
    const [tag, ...params] = part.trim().split(";");
    const qParam = params.find((p) => /^\s*q\s*=/i.test(p));
    const q = qParam === undefined ? 1 : /^\s*q\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*$/i.test(qParam) ? Number(qParam.split("=")[1]) : NaN; // malformed q: entry ignored
    return { tag: tag.trim(), q, index };
  }).filter((e) => e.tag && e.tag !== "*" && Number.isFinite(e.q) && e.q > 0);
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  for (const e of entries) {
    const base = e.tag.toLowerCase().split(/[-_]/)[0];
    if ((enabledLocales() as string[]).includes(base)) return base as Locale;
  }
  return DEFAULT_LOCALE;
}

/** Accepts a cookie value, query value or Accept-Language-like tag; anything else is English. */
export function resolveLocale(input: string | null | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  const base = String(input).trim().toLowerCase().split(/[-_]/)[0];
  return (enabledLocales() as string[]).includes(base) ? (base as Locale) : DEFAULT_LOCALE;
}
