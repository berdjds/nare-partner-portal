"use client";

import { Check } from "lucide-react";
import { useT } from "@/lib/i18n/react";

const KEYS = ["landing.benefit1", "landing.benefit2", "landing.benefit3", "landing.benefit4"] as const;

export function Benefits() {
  const t = useT();
  return (
    <section id="benefits" aria-labelledby="benefits-heading" className="bg-background">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:py-16 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
        <div>
          <h2 id="benefits-heading" className="font-display text-3xl leading-tight text-plum sm:text-4xl">{t("landing.title.benefits")}</h2>
          <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {KEYS.map((k) => (
            <li key={k} className="flex items-start gap-3 rounded-card border border-border bg-card p-5 shadow-[var(--shadow-soft)]">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Check className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-base leading-relaxed text-foreground">{t(k)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
