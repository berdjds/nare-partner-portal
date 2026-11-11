"use client";

import { useT } from "@/lib/i18n/react";

const STEPS = [
  ["landing.step1.title", "landing.step1.body"],
  ["landing.step2.title", "landing.step2.body"],
  ["landing.step3.title", "landing.step3.body"],
  ["landing.step4.title", "landing.step4.body"],
] as const;

/** The four-step process on a charcoal band, as one ordered timeline so the sequence is announced and seen. */
export function HowItWorks() {
  const t = useT();
  return (
    <section id="how-it-works" aria-labelledby="how-heading" className="bg-plum text-white">
      <div className="mx-auto max-w-7xl px-6 py-14 lg:py-18">
        <h2 id="how-heading" className="font-display text-3xl leading-tight sm:text-4xl">{t("landing.title.steps")}</h2>
        <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
        <ol className="relative mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
          <span aria-hidden="true" className="pointer-events-none absolute start-6 end-6 top-6 hidden border-t border-dashed border-white/30 lg:block" />
          {STEPS.map(([title, body], i) => (
            <li key={title} className="relative">
              <span aria-hidden="true" className="font-display flex h-12 w-12 items-center justify-center rounded-full bg-warm text-xl text-plum ring-8 ring-plum">{i + 1}</span>
              <p className="font-display mt-5 text-xl">{t(title)}</p>
              <p className="mt-2 text-sm leading-relaxed text-white/80">{t(body)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
