/**
 * Public partner application page (W5b, staged wizard in W5f) —
 * /partners/apply.
 *
 * Deliberately outside the authenticated AppShell (allow-listed in
 * tests/ui/design-guard.test.ts): anyone can open it, signed in or not. It is
 * branded like the landing page and mints the signed form token
 * (lib/partners/abuse.ts) that the POST /api/partners/applications endpoint
 * verifies together with the honeypot and the submission limits.
 *
 * The token mint fails closed when NEXTAUTH_SECRET is unset; rather than
 * rendering a form whose submissions can never pass, the page then shows the
 * fallback notice with the contact email.
 */

import type { Metadata } from "next";
import { PAGE_TITLES, PARTNER_APPLY, robotsDirective } from "@/lib/portal-content";
import { ContactEmailLink } from "@/components/partners/ContactEmailLink";
import { issueFormToken } from "@/lib/partners/abuse";
import { ApplyWizard } from "@/components/partners/ApplyWizard";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";

// The form token is minted per request from the runtime signing secret and the
// current time. Without this the page is prerendered at BUILD time (nothing in
// it is dynamic): the secret does not exist during the image build, so the
// "not available" notice would be baked in, and a successful mint would be a
// stale frozen timestamp that expires after two hours.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: PAGE_TITLES.partnerApply,
  // Same owner decision as the landing page (INDEXABLE in lib/portal-content.ts).
  robots: robotsDirective(),
};

export default function PartnerApplyPage() {
  let formToken: string | null = null;
  try {
    formToken = issueFormToken();
  } catch {
    formToken = null;
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader active="apply" />
      <header className="relative overflow-hidden bg-gradient-to-br from-plum via-plum to-brand text-white">
        <span aria-hidden="true" className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: 'url("/brand/photos/yerevan-market.webp")' }} />
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-black/90 via-black/75 to-black/55" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-start gap-6 px-6 py-10 sm:py-14">
          <h1 className="relative text-balance text-3xl font-bold leading-tight tracking-tight drop-shadow-lg sm:text-4xl">
            {PARTNER_APPLY.headline}
          </h1>
          <p className="max-w-xl leading-relaxed relative text-white/90">
            {PARTNER_APPLY.intro}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-10">
        {formToken === null ? (
          <p role="alert" className="rounded-lg border border-border bg-card p-6 text-sm leading-relaxed">
            {PARTNER_APPLY.unavailable}{" "}
            <ContactEmailLink />
          </p>
        ) : (
          <ApplyWizard formToken={formToken} />
        )}
      </div>
      <PublicFooter />
    </main>
  );
}
