"use client";

import { useT } from "@/lib/i18n/react";
import { usePublicContact } from "@/lib/contact/react";

/**
 * Verified facts only. The founding year comes from the admin-managed contact configuration (visibility flags
 * respected). The benefit statements are NOT repeated here (they already appear above). Nothing here is a
 * marketing claim; with no verified fact to show, the section is not rendered.
 */
export function TrustStrip() {
  const t = useT();
  const c = usePublicContact();
  const facts: string[] = [];
  if (c.foundedYear) facts.push(t("footer.since", { year: c.foundedYear }));
  if (facts.length === 0) return null;
  return (
    <section id="trust" aria-labelledby="trust-heading" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 pb-4">
        <div className="flex flex-col items-center justify-between gap-3 rounded-card border border-border bg-card px-7 py-5 shadow-[var(--shadow-soft)] sm:flex-row">
          <h2 id="trust-heading" className="font-display text-xl text-plum">{t("landing.title.trust")}</h2>
          <ul className="flex flex-wrap items-center gap-3">
            {facts.map((f) => <li key={f} className="rounded-full bg-warm/20 px-4 py-1.5 text-sm font-semibold text-plum">{f}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}
