"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useT } from "@/lib/i18n/react";

/**
 * Image-led hero in staging.nare.am's system (components/hero-slider): a full-bleed Nare photograph, a dark horizontal
 * gradient overlay, a glass text panel with a bold white headline, and two pill buttons. The photograph is staging's own home hero
 * slide 1, copied locally (public/brand/photos, see SOURCES.md). The brand lockup is in the header only. Logical
 * properties and rtl: variants keep the layout correct if an RTL language is enabled later.
 */
export function Hero() {
  const t = useT();
  return (
    <section className="relative isolate overflow-hidden bg-footer text-white">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/photos/hero-expo-1920.webp"
        srcSet="/brand/photos/hero-expo-960.webp 960w, /brand/photos/hero-expo-1920.webp 1920w"
        sizes="100vw"
        alt={t("hero.photo.alt")}
        width={1920}
        height={1440}
        fetchPriority="high"
        className="absolute inset-0 -z-20 h-full w-full object-cover object-[72%_30%] md:object-[60%_28%]"
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-black/85 via-black/65 to-black/40 md:from-black/80 md:via-black/50 md:to-black/10 rtl:bg-gradient-to-l" />
      {/* Soft floor so the stand signage at the photo's lower edge never reads as a second logo when the crop is tall (tablet, phone). */}
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 -z-10 h-1/3 bg-gradient-to-t from-black/80 to-transparent lg:hidden" />
      <div className="mx-auto flex min-h-[32rem] max-w-7xl items-center px-6 py-14 sm:min-h-[36rem] lg:min-h-[40rem] lg:py-20">
        <div className="relative max-w-2xl rounded-2xl bg-gradient-to-r from-black/45 via-black/25 to-transparent p-6 sm:p-9 rtl:bg-gradient-to-l">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/85">{t("landing.eyebrow")}</p>
          <h1 className="mt-4 text-balance font-display hero-h1 text-3xl leading-[1.1] tracking-tight drop-shadow-lg sm:text-4xl lg:text-5xl">{t("landing.headline")}</h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/90 drop-shadow-md sm:text-xl">{t("landing.subline")}</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link href="/login" className="pill-btn pill-btn-primary group px-8 py-4 text-base">
              {t("common.signIn")}
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1" aria-hidden="true" />
            </Link>
            <Link href="/partners/apply" className="pill-btn pill-btn-ghost px-8 py-4 text-base">
              {t("nav.apply")}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
