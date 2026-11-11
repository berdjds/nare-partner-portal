"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n/react";

/**
 * Photo-led gateway. A photograph copied from staging.nare.am (public/brand/photos, see SOURCES.md) in an asymmetric
 * composition with an offset aubergine block; the only brand lockup on the page is the header logo. Sign in is the primary action, Become a partner the
 * secondary one. Logical properties only, so the layout mirrors if an RTL language is enabled later.
 */
export function Hero() {
  const t = useT();
  return (
    <section className="relative overflow-hidden bg-background">
      <div aria-hidden="true" className="pointer-events-none absolute -end-32 -top-40 h-[34rem] w-[34rem] rounded-full bg-brand/10 blur-3xl" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-8 px-6 pb-14 pt-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-12 lg:pb-20 lg:pt-12">
        <div className="order-2 lg:order-1">
          <p className="text-sm font-semibold tracking-wide text-brand">{t("landing.eyebrow")}</p>
          <h1 className="font-display mt-3 text-balance text-4xl leading-[1.08] text-plum sm:text-5xl lg:text-[3.3rem]">{t("landing.headline")}</h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">{t("landing.subline")}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              href="/login"
              className="inline-flex h-12 min-w-44 items-center justify-center gap-2 rounded-xl bg-primary px-7 text-base font-semibold text-primary-foreground shadow-[var(--shadow-soft)] transition hover:bg-primary/90 hover:shadow-[var(--shadow-lift)]"
            >
              {t("common.signIn")}
              <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
            </Link>
            <Link
              href="/partners/apply"
              className="inline-flex h-12 items-center justify-center rounded-xl border-2 border-plum/25 bg-card/60 px-7 text-base font-semibold text-plum transition hover:border-plum/50 hover:bg-card"
            >
              {t("nav.apply")}
            </Link>
          </div>
        </div>

        <div className="relative order-1 lg:order-2">
          <div aria-hidden="true" className="absolute -bottom-5 -end-5 h-3/4 w-3/4 rounded-[32px] bg-plum" />
          <div aria-hidden="true" className="absolute -start-5 -top-5 h-24 w-24 rounded-full border-[14px] border-warm/50" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/photos/hero-expo.webp"
            alt={t("hero.photo.alt")}
            width={1400}
            height={1050}
            fetchPriority="high"
            className="relative aspect-[4/3] w-full rounded-[28px] object-cover shadow-[var(--shadow-lift)] md:aspect-[16/9] lg:aspect-[5/4]"
          />
        </div>
      </div>
    </section>
  );
}
