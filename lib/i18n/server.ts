import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, resolveLocale, type Locale } from "@/lib/i18n/locales";

/**
 * Locale of the current request: the explicit cookie choice wins; otherwise the browser's
 * Accept-Language is honoured only for an ENABLED locale; otherwise English. Never throws.
 */
export async function getRequestLocale(): Promise<Locale> {
  try {
    const c = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (c) return resolveLocale(c);
    const al = (await headers()).get("accept-language") ?? "";
    for (const part of al.split(",")) {
      const tag = part.split(";")[0].trim();
      const l = resolveLocale(tag);
      if (l !== DEFAULT_LOCALE) return l;
    }
  } catch { /* outside a request (tests, scripts) */ }
  return DEFAULT_LOCALE;
}
