/**
 * Public reset-password page (W6a) — /reset-password, step 2 of the
 * self-service password reset, reached from the emailed link (?token=...).
 *
 * Deliberately outside the authenticated AppShell (allow-listed in
 * tests/ui/design-guard.test.ts): anyone can open it, signed in or not. A
 * missing, used or expired token gets the same generic invalid-link wording
 * the confirm endpoint returns, so nothing about the account or the token
 * leaks through the page.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import { PAGE_TITLES, robotsDirective } from "@/lib/portal-content";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";

export const metadata: Metadata = {
  title: PAGE_TITLES.resetPassword,
  // Same owner decision as the landing page (INDEXABLE in lib/portal-content.ts).
  robots: robotsDirective(),
};

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex flex-1 items-center justify-center bg-background px-4 py-10">
        {/* useSearchParams needs a Suspense boundary at prerender time. */}
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </main>
      <PublicFooter />
    </div>
  );
}
