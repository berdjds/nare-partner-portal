"use client";

import { B2B_SERVICES } from "@/lib/portal-content";
import { useT } from "@/lib/i18n/react";
import { usePublicContact } from "@/lib/contact/react";

/**
 * About Nare: an asymmetric story section. Photograph: staging's About banner (public/brand/photos/about-monastery.webp).
 * The founding year comes from the admin-managed contact settings (hidden when the admin hides it); every sentence restates
 * approved wording or facts already shown elsewhere. No statistics, awards or superlatives.
 */
export function AboutNare() {
  const t = useT();
  const c = usePublicContact();
  return (
    <section id="about" aria-labelledby="about-heading" className="bg-background">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-6 py-14 lg:grid-cols-12 lg:gap-14 lg:py-20">
        <div className="relative lg:col-span-5 lg:pt-6">
          <div aria-hidden="true" className="absolute -start-4 -bottom-4 h-2/3 w-2/3 rounded-[2rem] bg-plum" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/photos/about-monastery.webp" alt={t("about.photo.alt")} width={669} height={446} loading="lazy" className="relative aspect-[5/4] max-h-[26rem] w-full rounded-[2rem] object-cover shadow-[var(--shadow-lift)]" />
        </div>
        <div className="lg:col-span-7">
          <h2 id="about-heading" className="font-display text-balance leading-[1.05] text-plum">{t("landing.title.trust")}</h2>
          <p className="mt-6 text-xl leading-relaxed text-foreground md:text-[1.35rem]">{c.foundedYear ? t("about.p1.year", { year: c.foundedYear }) : t("about.p1")}</p>
          <div className="mt-6 grid gap-6 text-[17px] leading-relaxed text-muted-foreground md:grid-cols-2">
            <p>{t("about.p2")}</p>
            <p>{t("about.p3")}</p>
          </div>
          <p className="mt-6 text-[17px] font-medium text-foreground">{t("about.p4")}</p>
          <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-border pt-6 sm:max-w-md">
            {c.foundedYear ? (
              <div>
                <dd className="font-display text-5xl font-semibold leading-none text-brand">{c.foundedYear}</dd>
                <dt className="mt-2 text-base text-muted-foreground">{t("about.founded")}</dt>
              </div>
            ) : null}
            <div>
              <dd className="font-display text-5xl font-semibold leading-none text-brand">{B2B_SERVICES.length}</dd>
              <dt className="mt-2 text-base text-muted-foreground">{t("about.groups")}</dt>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
