"use client";

import { useT } from "@/lib/i18n/react";

const SERVICES = [
  ["landing.service1.title", "landing.service1.body"],
  ["landing.service2.title", "landing.service2.body"],
  ["landing.service3.title", "landing.service3.body"],
] as const;

/** The three core service groups, no more. */
export function ServicesSection() {
  const t = useT();
  return (
    <section id="services" aria-labelledby="services-heading" className="bg-muted">
      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h2 id="services-heading" className="text-center text-3xl font-semibold tracking-tight text-foreground">{t("landing.title.services")}</h2>
        <span aria-hidden="true" className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm" />
        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {SERVICES.map(([title, body]) => (
            <li key={title} className="rounded-xl border border-border bg-card p-6">
              <p className="text-lg font-semibold text-foreground">{t(title)}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(body)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
