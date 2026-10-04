/**
 * Public partner application page (W5b) — /partners/apply.
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
import { CONTACT, PAGE_TITLES, PARTNER_APPLY, robotsDirective } from "@/lib/portal-content";
import { issueFormToken } from "@/lib/partners/abuse";
import { ApplyForm } from "@/components/partners/ApplyForm";
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
      <header className="bg-gradient-to-br from-primary to-brand text-primary-foreground">
        <div className="mx-auto flex max-w-2xl flex-col items-start gap-6 px-6 py-12">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {PARTNER_APPLY.headline}
          </h1>
          <p className="max-w-xl leading-relaxed text-primary-foreground/90">
            {PARTNER_APPLY.intro}
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-10">
        {formToken === null ? (
          <p role="alert" className="rounded-lg border border-border bg-card p-6 text-sm leading-relaxed">
            {PARTNER_APPLY.unavailable}{" "}
            <a href={`mailto:${CONTACT.email}`} className="text-primary underline underline-offset-4">
              {CONTACT.email}
            </a>
          </p>
        ) : (
          <ApplyForm formToken={formToken} />
        )}
      </div>
      <PublicFooter />
    </main>
  );
}
