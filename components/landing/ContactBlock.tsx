"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n/react";

/**
 * Closing call to action in staging's blue CTA band (components/dmc-section). Contact details live in the footer only, so
 * nothing is repeated here.
 */
export function ContactBlock() {
  const t = useT();
  return (
    <section id="contact" aria-labelledby="contact-heading" className="bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-16 lg:pb-24">
        <div className="flex flex-col items-start justify-between gap-8 rounded-[2rem] bg-primary p-8 text-primary-foreground shadow-[var(--shadow-lift)] md:flex-row md:items-center md:p-12">
          <h2 id="contact-heading" className="font-display max-w-xl text-balance text-[clamp(1.9rem,3.6vw,3rem)] font-semibold leading-[1.08]">{t("cta.title")}</h2>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link href="/login" className="pill-btn pill-btn-light group px-8 py-4 text-base">
              {t("common.signIn")}
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" aria-hidden="true" />
            </Link>
            <Link href="/partners/apply" className="pill-btn pill-btn-ghost px-8 py-4 text-base">{t("nav.apply")}</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
