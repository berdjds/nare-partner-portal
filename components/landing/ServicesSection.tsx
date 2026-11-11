"use client";

import { useT } from "@/lib/i18n/react";

const SERVICES = [
  ["landing.service1.title", "landing.service1.body"],
  ["landing.service2.title", "landing.service2.body"],
  ["landing.service3.title", "landing.service3.body"],
] as const;

/** The three core service groups, as an editorial list (no card grid): numeral, serif title, one sentence. */
export function ServicesSection() {
  const t = useT();
  return (
    <section id="services" aria-labelledby="services-heading" className="bg-background">
      <div className="mx-auto grid max-w-7xl gap-8 px-6 pb-14 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16 lg:pb-20">
        <div>
          <h2 id="services-heading" className="font-display text-3xl leading-tight text-plum sm:text-4xl lg:sticky lg:top-24">{t("landing.title.services")}</h2>
          <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
        </div>
        <ul className="divide-y divide-border border-y border-border">
          {SERVICES.map(([title, body], i) => (
            <li key={title} className="grid grid-cols-[3.5rem_1fr] items-baseline gap-4 py-7 sm:grid-cols-[4.5rem_1fr_1.2fr] sm:gap-6">
              <span aria-hidden="true" className="font-display text-3xl text-brand sm:text-4xl">0{i + 1}</span>
              <p className="font-display text-2xl text-plum">{t(title)}</p>
              <p className="col-start-2 text-[15px] leading-relaxed text-muted-foreground sm:col-start-3">{t(body)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
