"use client";

import { useT } from "@/lib/i18n/react";
import { usePublicContact } from "@/lib/contact/react";

/**
 * Verified facts only. The founding year and contact data come from the admin-managed contact
 * configuration (visibility flags respected). The benefit statements are NOT repeated here (they
 * already appear in the section above). Nothing here is a marketing claim.
 */
export function TrustStrip() {
  const t = useT();
  const c = usePublicContact();
  const facts: string[] = [];
  if (c.foundedYear) facts.push(t("footer.since", { year: c.foundedYear }));
  if (facts.length === 0) return null; // nothing verified to show: no empty section, and no repeat of the benefits above
  return (
    <section id="trust" aria-labelledby="trust-heading" className="border-y border-border bg-card">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <h2 id="trust-heading" className="text-center text-xl font-semibold tracking-tight text-foreground">{t("landing.title.trust")}</h2>
        <ul className="mt-6 grid gap-3 text-center text-sm text-muted-foreground sm:grid-cols-1 sm:mx-auto sm:max-w-sm">
          {facts.map((f) => <li key={f} className="rounded-lg bg-muted px-4 py-3 text-foreground">{f}</li>)}
        </ul>
      </div>
    </section>
  );
}
