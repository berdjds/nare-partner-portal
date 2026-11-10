import { en, type MessageKey } from "./en";
import { hy } from "./hy";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales";

export type { MessageKey };
export const MESSAGES: Record<string, Record<string, string>> & { en: Record<string, string>; hy: Record<string, string> } = { en, hy };

export const placeholdersOf = (s: string): string[] => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();

/** English keys a locale does not define (what the completeness test asserts is empty). */
export function missingKeys(locale: Locale): string[] {
  const table = MESSAGES[locale];
  return Object.keys(en).filter((k) => !table || !(k in table));
}

/**
 * Locale text, else English, else the key itself (visible in development, never empty).
 * Variables are plain-text substitutions; React escapes them at render.
 */
export function translate(key: MessageKey, locale: Locale, vars?: Record<string, string | number>): string {
  const table = MESSAGES[locale];
  const raw = table?.[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : raw;
}
