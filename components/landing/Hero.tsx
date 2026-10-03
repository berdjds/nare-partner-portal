import Link from "next/link";
import { HERO, PRODUCT_NAME } from "@/lib/portal-content";

export function Hero() {
  return (
    <section className="bg-gradient-to-br from-primary to-brand text-primary-foreground">
      <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-24 text-center sm:py-32">
        {/* Text wordmark until the real logo asset ships; no image file exists yet. */}
        <span className="text-2xl font-bold uppercase tracking-[0.2em]">
          {PRODUCT_NAME}
        </span>
        <h1 className="mt-10 text-4xl font-semibold tracking-tight sm:text-5xl">
          {HERO.headline}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-primary-foreground/90">
          {HERO.subline}
        </p>
        <Link
          href="/login"
          className="mt-10 inline-flex h-12 items-center justify-center rounded-lg bg-card px-8 text-base font-semibold text-primary shadow-sm transition-colors hover:bg-muted"
        >
          {HERO.ctaLabel}
        </Link>
      </div>
    </section>
  );
}
