"use client";

import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { useT } from "@/lib/i18n/react";
import { usePublicContact } from "@/lib/contact/react";

const STEP_KEYS = ["landing.step1.title", "landing.step2.title", "landing.step3.title", "landing.step4.title"] as const;

/**
 * Focused B2B gateway: one promise, Sign in as the primary action, Become a partner as the secondary one.
 * No photograph is shipped (none is approved), so the visual side is a graphic collage made of the Nare
 * mark and the real four-step process; it carries no figures or claims. Layout uses logical properties so it
 * mirrors correctly if an RTL language is enabled later.
 */
export function Hero() {
  const t = useT();
  const contact = usePublicContact();
  return (
    <section className="relative overflow-hidden bg-background">
      <div aria-hidden="true" className="pointer-events-none absolute -end-24 -top-24 h-[28rem] w-[28rem] rounded-full bg-brand/10 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -start-24 h-80 w-80 rounded-full bg-warm/15 blur-3xl" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-6 py-12 sm:py-16 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:py-20">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/5 px-3.5 py-1.5 text-sm font-medium text-brand">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
            {t("landing.eyebrow")}
          </span>
          <h1 className="font-display mt-6 text-4xl leading-[1.08] text-plum sm:text-5xl lg:text-[3.5rem]">{t("landing.headline")}</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">{t("landing.subline")}</p>
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

        <div className="relative mx-auto w-full max-w-md lg:max-w-none" aria-hidden="true">
          <div className="relative rounded-[28px] bg-gradient-to-br from-plum via-plum to-brand p-8 text-white shadow-[var(--shadow-lift)] lg:me-10">
            <div className="flex items-center gap-4">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/95 shadow-inner">
                <span className="h-11 w-11 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: 'url("/brand/nare-icon.webp")' }} />
              </span>
              <span className="font-display text-2xl leading-tight">Nare<br />Travel and Tours</span>
            </div>
            <div className="mt-8 h-24 rounded-2xl border border-white/20 bg-white/10" />
            <div className="mt-3 flex gap-3">
              <span className="h-10 flex-1 rounded-xl bg-white/15" />
              <span className="h-10 w-24 rounded-xl bg-warm/90" />
            </div>
          </div>
          <div className="relative -mt-14 ms-6 rounded-[24px] border border-border bg-card p-5 shadow-[var(--shadow-soft)] lg:ms-24 lg:-mt-24">
            <ol className="space-y-3">
              {STEP_KEYS.map((k, i) => (
                <li key={k} className="flex items-center gap-3 text-sm font-medium text-foreground">
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${i < 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    {i < 2 ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                  </span>
                  {t(k)}
                </li>
              ))}
            </ol>
          </div>
          {contact.foundedYear ? (
            <span className="absolute -top-3 end-2 rounded-full bg-warm px-4 py-1.5 text-sm font-semibold text-plum shadow-[var(--shadow-soft)] lg:end-0">
              {t("footer.since", { year: contact.foundedYear })}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
