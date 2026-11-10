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
      <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
        <h2 id="how-heading" className="text-center text-3xl font-semibold tracking-tight text-foreground">{t("landing.title.steps")}</h2>
        <span aria-hidden="true" className="mx-auto mt-4 block h-1 w-12 rounded-full bg-warm" />
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="rounded-xl border border-border bg-card p-6">
              <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{i + 1}</span>
              <p className="mt-4 text-lg font-semibold text-foreground">{t(title)}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(body)}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
