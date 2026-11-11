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
    <section id="services" aria-labelledby="services-heading" className="bg-muted/70">
      <div className="mx-auto max-w-6xl px-6 py-12 sm:py-16">
        <h2 id="services-heading" className="font-display max-w-xl text-3xl leading-tight text-plum sm:text-4xl">{t("landing.title.services")}</h2>
        <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
        <ul className="mt-8 grid gap-5 md:grid-cols-3">
          {SERVICES.map(([title, body], i) => (
            <li
              key={title}
              className={`flex flex-col rounded-card p-7 shadow-[var(--shadow-soft)] ${i === 0 ? "bg-plum text-white md:-translate-y-3" : "border border-border bg-card"}`}
            >
              <span aria-hidden="true" className={`font-display text-4xl ${i === 0 ? "text-warm" : "text-brand"}`}>0{i + 1}</span>
              <p className={`font-display mt-6 text-2xl ${i === 0 ? "text-white" : "text-plum"}`}>{t(title)}</p>
              <p className={`mt-3 text-sm leading-relaxed ${i === 0 ? "text-white/85" : "text-muted-foreground"}`}>{t(body)}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
