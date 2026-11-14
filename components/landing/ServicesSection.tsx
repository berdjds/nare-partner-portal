"use client";

import { useT } from "@/lib/i18n/react";

const SERVICES = [
  ["landing.service1.title", "landing.service1.body"],
  ["landing.service2.title", "landing.service2.body"],
  ["landing.service3.title", "landing.service3.body"],
] as const;

/**
 * The three core service groups in staging's services layout (components/services-premium): one large image-backed
 * feature tile and two compact tiles. Photograph: staging home hero slide 2 (public/brand/photos/yerevan-market.webp).
 */
export function ServicesSection() {
  const t = useT();
  return (
    <section id="services" aria-labelledby="services-heading" className="bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-14 lg:pb-20">
        <h2 id="services-heading" className="font-display max-w-2xl text-balance leading-[1.05] text-plum">{t("landing.title.services")}</h2>
        <ul className="mt-8 grid gap-5 lg:grid-cols-3 lg:grid-rows-2">
          {SERVICES.map(([title, body], i) =>
            i === 0 ? (
              <li key={title} className="relative isolate flex min-h-[22rem] flex-col justify-end overflow-hidden rounded-[2rem] bg-footer text-white lg:col-span-2 lg:row-span-2 lg:min-h-[30rem]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/photos/yerevan-market.webp" alt="" width={1280} height={720} loading="lazy" className="absolute inset-0 -z-20 h-full w-full object-cover object-[50%_25%]" />
                <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/35 to-black/5" />
                <div className="p-7 md:p-10">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">01</p>
                  <p className="font-display mt-2 text-[clamp(1.9rem,3.2vw,3rem)] font-semibold leading-tight">{t(title)}</p>
                  <p className="mt-3 max-w-xl text-lg text-white/85">{t(body)}</p>
                </div>
              </li>
            ) : (
              <li key={title} className={`flex flex-col justify-between rounded-[2rem] p-7 md:p-9 ${i === 1 ? "bg-footer text-white" : "bg-plum text-white"}`}>
                <p className="font-display text-4xl text-warm">0{i + 1}</p>
                <div className="mt-10">
                  <p className="font-display text-[1.7rem] font-semibold leading-tight">{t(title)}</p>
                  <p className="mt-2 text-base leading-relaxed text-white/70">{t(body)}</p>
                </div>
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}
