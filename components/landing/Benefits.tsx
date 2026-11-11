"use client";

import { useT } from "@/lib/i18n/react";

const KEYS = ["landing.benefit1", "landing.benefit2", "landing.benefit3", "landing.benefit4"] as const;

/** The four partner benefits as one quiet row: a numeral and a hairline each, no boxes. */
export function Benefits() {
  const t = useT();
  return (
    <section id="benefits" aria-labelledby="benefits-heading" className="bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:py-16">
        <h2 id="benefits-heading" className="eyebrow">{t("landing.title.benefits")}</h2>
        <ul className="mt-6 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {KEYS.map((k, i) => (
            <li key={k} className="border-t-2 border-brand/25 pt-4">
              <span aria-hidden="true" className="font-display text-sm font-semibold text-brand">0{i + 1}</span>
              <p className="mt-2 text-[15px] leading-relaxed text-foreground">{t(k)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
