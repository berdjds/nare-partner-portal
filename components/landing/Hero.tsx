"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/react";

/** Focused B2B gateway: one promise, Sign in as the primary action, Become a partner as the secondary one. */
export function Hero() {
  const t = useT();
  return (
    <section className="bg-gradient-to-br from-primary to-gradient-end text-primary-foreground">
      <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-20 text-center sm:py-28">
        <span
          aria-hidden="true"
          className="mb-6 h-14 w-14 bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: 'url("/brand/nare-icon.webp")' }}
        />
        <span className="text-sm font-medium tracking-wide">{t("landing.eyebrow")}</span>
        <h1 className="mt-8 text-4xl font-semibold tracking-tight sm:text-5xl">{t("landing.headline")}</h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-primary-foreground/90">{t("landing.subline")}</p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex h-12 min-w-40 items-center justify-center rounded-lg bg-card px-8 text-base font-semibold text-primary shadow-sm transition-colors hover:bg-muted"
          >
            {t("common.signIn")}
          </Link>
          <Link
            href="/partners/apply"
            className="inline-flex h-12 items-center justify-center rounded-lg border-2 border-primary-foreground px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-foreground/10"
          >
            {t("nav.apply")}
          </Link>
        </div>
      </div>
    </section>
  );
}
