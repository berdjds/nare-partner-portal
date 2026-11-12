"use client";

import { LOCALE_COOKIE, LOCALES, enabledLocales, type Locale } from "@/lib/i18n/locales";
import { useLocale, useT } from "@/lib/i18n/react";

/** Switches the interface language: stores the choice in a cookie and reloads the page so the server renders it in the new language. */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const current = useLocale();
  const t = useT();

  function choose(l: Locale) {
    if (l === current) return;
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    window.location.reload(); // re-renders every server component in the new language
  }

  return (
    <div role="group" aria-label={t("lang.label")} className={`inline-flex items-center gap-1 ${className}`}>
      {enabledLocales().map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === current}
          onClick={() => choose(l)}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-2 text-sm ${l === current ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {l === "en" ? "EN" : l === "hy" ? "ՀԱՅ" : LOCALES[l].label}
        </button>
      ))}
    </div>
  );
}
