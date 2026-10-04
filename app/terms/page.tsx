/**
 * Public Terms of Use page (W5f, task legal-pages) — /terms.
 *
 * Deliberately outside the authenticated AppShell (allow-listed in
 * tests/ui/design-guard.test.ts): anyone can open it, signed in or not, like
 * the landing page. Renders the drafted TERMS_OF_USE from lib/legal-content.ts
 * through the shared LegalPage renderer with the public header and footer;
 * the wording itself is owned by the draft and is not edited here.
 */

import type { Metadata } from "next";
import { TERMS_OF_USE } from "@/lib/legal-content";
import { PRODUCT_NAME, robotsDirective } from "@/lib/portal-content";
import { LegalPage } from "@/components/public/LegalPage";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";

export const metadata: Metadata = {
  title: `${TERMS_OF_USE.title} — ${PRODUCT_NAME} Portal`,
  // Same owner decision as the landing page (INDEXABLE in lib/portal-content.ts).
  robots: robotsDirective(),
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <LegalPage document={TERMS_OF_USE} />
      <PublicFooter />
    </main>
  );
}
