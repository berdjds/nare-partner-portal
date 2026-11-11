"use client";

import { useT } from "@/lib/i18n/react";

const STEPS = [
  ["landing.step1.title", "landing.step1.body"],
  ["landing.step2.title", "landing.step2.body"],
  ["landing.step3.title", "landing.step3.body"],
  ["landing.step4.title", "landing.step4.body"],
] as const;

/** The four-step process on staging's charcoal section (glow, hairline-divided cells); an ordered list so the sequence is announced. */
export function HowItWorks() {
  const t = useT();
  return (
    <section id="how-it-works" aria-labelledby="how-heading" className="relative overflow-hidden bg-footer text-white">
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 -end-24 h-[32rem] w-[32rem] rounded-full bg-brand/25 blur-[120px]" />
      <div className="relative mx-auto max-w-7xl px-6 section-y">
        <h2 id="how-heading" className="font-display max-w-xl text-balance text-[clamp(2rem,4.2vw,3.4rem)] font-semibold leading-[1.05]">{t("landing.title.steps")}</h2>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-[2rem] bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="bg-footer p-7 transition-colors duration-300 hover:bg-white/[0.04] md:p-8">
              <span aria-hidden="true" className="font-display text-5xl font-semibold leading-none text-warm">{i + 1}</span>
              <p className="font-display mt-6 text-xl font-semibold">{t(title)}</p>
              <p className="mt-2 text-sm leading-relaxed text-white/65">{t(body)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
