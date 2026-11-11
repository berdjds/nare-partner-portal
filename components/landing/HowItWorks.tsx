"use client";

import { useT } from "@/lib/i18n/react";

const STEPS = [
  ["landing.step1.title", "landing.step1.body"],
  ["landing.step2.title", "landing.step2.body"],
  ["landing.step3.title", "landing.step3.body"],
  ["landing.step4.title", "landing.step4.body"],
] as const;

/** The four-step process, as an ordered list so the sequence is announced. */
export function HowItWorks() {
  const t = useT();
  return (
    <section id="how-it-works" aria-labelledby="how-heading" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-12 sm:py-16">
        <h2 id="how-heading" className="font-display text-3xl leading-tight text-plum sm:text-4xl">{t("landing.title.steps")}</h2>
        <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
        <ol className="relative mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <span aria-hidden="true" className="pointer-events-none absolute start-8 end-8 top-[2.1rem] hidden border-t-2 border-dashed border-brand/30 lg:block" />
          {STEPS.map(([title, body], i) => (
            <li key={title} className="relative rounded-card border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
              <span aria-hidden="true" className="font-display flex h-12 w-12 items-center justify-center rounded-full bg-brand text-xl text-white ring-4 ring-background">{i + 1}</span>
              <p className="font-display mt-5 text-xl text-plum">{t(title)}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(body)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
