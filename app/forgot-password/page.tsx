/**
 * Public forgot-password page (W6a) — /forgot-password, step 1 of the
 * self-service password reset.
 *
 * Deliberately outside the authenticated AppShell (allow-listed in
 * tests/ui/design-guard.test.ts): anyone can open it, signed in or not. The
 * form always ends in the same generic success wording, whether or not the
 * email belongs to an account, so the page cannot be used to probe which
 * emails are registered (anti-enumeration).
 */

import type { Metadata } from "next";
import { PAGE_TITLES, robotsDirective } from "@/lib/portal-content";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";

export const metadata: Metadata = {
  title: PAGE_TITLES.forgotPassword,
  // Same owner decision as the landing page (INDEXABLE in lib/portal-content.ts).
  robots: robotsDirective(),
};

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <PublicHeader />
      <main className="flex flex-1 items-center justify-center bg-background px-4 py-10">
        <ForgotPasswordForm />
      </main>
      <PublicFooter />
    </div>
  );
}
