"use client";

import { createContext, useCallback, useContext } from "react";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/locales";
import { translate, type MessageKey } from "@/lib/i18n/messages";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Supplied once by the root layout. Without a provider everything renders in English. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): Locale => useContext(LocaleContext);

export function useT() {
  const locale = useLocale();
  return useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(key, locale, vars), [locale]);
}
