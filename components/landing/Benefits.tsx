"use client";

import { Check } from "lucide-react";
import { useT } from "@/lib/i18n/react";

const KEYS = ["landing.benefit1", "landing.benefit2", "landing.benefit3", "landing.benefit4"] as const;

export function Benefits() {
  const t = useT();
  return (
    <section id="benefits" aria-labelledby="benefits-heading" className="bg-background">
      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h2 id="benefits-heading" className="text-center text-3xl font-semibold tracking-tight text-foreground">{t("landing.title.benefits")}</h2>
        <span aria-hidden="true" className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm" />
        <ul className="mt-10 grid gap-4 sm:grid-cols-2">
          {KEYS.map((k) => (
            <li key={k} className="flex items-start gap-3 rounded-xl border border-border bg-card p-5">
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
              <span className="text-base leading-relaxed text-foreground">{t(k)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
