import { cookies, headers } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, pickFromAcceptLanguage, resolveLocale, type Locale } from "@/lib/i18n/locales";

/**
 * Locale of the current request: the explicit cookie choice wins; otherwise the browser's
 * Accept-Language is honoured only for an ENABLED locale; otherwise English. Never throws.
 */
export async function getRequestLocale(): Promise<Locale> {
  try {
    const c = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (c) return resolveLocale(c);
    return pickFromAcceptLanguage((await headers()).get("accept-language"));
  } catch { /* outside a request (tests, scripts) */ }
  return DEFAULT_LOCALE;
}
