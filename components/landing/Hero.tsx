import Link from "next/link";
import { HERO, PARTNER_APPLY } from "@/lib/portal-content";

export function Hero() {
  return (
    <section className="bg-gradient-to-br from-primary to-gradient-end text-primary-foreground">
      <div className="mx-auto flex max-w-4xl flex-col items-center px-6 py-24 text-center sm:py-32">
        <span
          aria-hidden="true"
          className="mb-6 h-12 w-12 bg-contain bg-center bg-no-repeat"
          style={{ backgroundImage: 'url("/brand/nare-icon.webp")' }}
        />
        <span className="text-sm font-medium tracking-wide">
          Partner portal
        </span>
        <h1 className="mt-10 text-4xl font-semibold tracking-tight sm:text-5xl">
          {HERO.headline}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-primary-foreground/90">
          {HERO.subline}
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <Link
            href="/login"
            className="inline-flex h-12 items-center justify-center rounded-lg bg-card px-8 text-base font-semibold text-primary shadow-sm transition-colors hover:bg-muted"
          >
            {HERO.ctaLabel}
          </Link>
          <Link
            href="/partners/apply"
            className="inline-flex h-12 items-center justify-center rounded-lg border-2 border-primary-foreground px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-foreground/10"
          >
            {PARTNER_APPLY.linkLabel}
          </Link>
        </div>
      </div>
    </section>
  );
}
