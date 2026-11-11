"use client";

import { useT } from "@/lib/i18n/react";
import { usePublicContact } from "@/lib/contact/react";

/**
 * About Nare: a photograph from staging.nare.am, the founding year (from the admin-managed contact settings, hidden when
 * the admin hides it) and three plain sentences built only from verified facts. No statistics or superlatives.
 */
export function AboutNare() {
  const t = useT();
  const c = usePublicContact();
  return (
    <section id="about" aria-labelledby="about-heading" className="bg-background">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-6 py-14 lg:grid-cols-[1fr_1fr] lg:gap-16 lg:py-20">
        <div className="relative">
          <div aria-hidden="true" className="absolute -start-4 -top-4 h-2/3 w-2/3 rounded-[28px] bg-warm/40" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/photos/about-monastery.webp" alt={t("about.photo.alt")} width={669} height={446} loading="lazy" className="relative aspect-[3/2] w-full rounded-[28px] object-cover shadow-[var(--shadow-lift)] md:aspect-[16/9] lg:aspect-[3/2]" />
        </div>
        <div>
          <h2 id="about-heading" className="font-display text-3xl leading-tight text-plum sm:text-4xl">{t("landing.title.trust")}</h2>
          <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
          <div className="mt-6 space-y-4 text-base leading-relaxed text-foreground">
            <p>{c.foundedYear ? t("about.p1.year", { year: c.foundedYear }) : t("about.p1")}</p>
            <p className="text-muted-foreground">{t("about.p2")}</p>
            <p className="text-muted-foreground">{t("about.p3")}</p>
          </div>
          {c.foundedYear ? (
            <p className="mt-8 flex items-baseline gap-3 border-t border-border pt-6">
              <span className="font-display text-5xl text-brand">{c.foundedYear}</span>
              <span className="text-sm font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("about.founded")}</span>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
