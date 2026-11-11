"use client";

import { Check } from "lucide-react";
import { useT } from "@/lib/i18n/react";

const KEYS = ["landing.benefit1", "landing.benefit2", "landing.benefit3", "landing.benefit4"] as const;

/** One continuous band (not four boxes): the four partner benefits side by side, divided by hairlines. */
export function Benefits() {
  const t = useT();
  return (
    <section id="benefits" aria-labelledby="benefits-heading" className="bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-14 lg:pb-20">
        <h2 id="benefits-heading" className="sr-only">{t("landing.title.benefits")}</h2>
        <ul className="grid divide-y divide-border rounded-card border border-border bg-card shadow-[var(--shadow-soft)] sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x rtl:lg:divide-x-reverse">
          {KEYS.map((k) => (
            <li key={k} className="flex items-start gap-3 p-6 sm:[&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-border lg:[&:nth-child(n+3)]:border-t-0">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Check className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-[15px] leading-relaxed text-foreground">{t(k)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
