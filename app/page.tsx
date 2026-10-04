import type { Metadata } from "next";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { canUseInbox, getActiveUser } from "@/lib/access-policy";
import { PAGE_TITLES, robotsDirective } from "@/lib/portal-content";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Benefits } from "@/components/landing/Benefits";
import { ContactBlock } from "@/components/landing/ContactBlock";
import { PublicHeader } from "@/components/public/PublicHeader";
import { PublicFooter } from "@/components/public/PublicFooter";

export const metadata: Metadata = {
  title: PAGE_TITLES.home,
  // Stays noindex until the owner approves indexing (INDEXABLE flag in
  // lib/portal-content.ts).
  robots: robotsDirective(),
};

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  // Interim W1 policy (lib/access-policy.ts): the role is re-read from the
  // database, so deactivation takes effect on the next request. A session
  // whose user row is gone or inactive counts as signed out and sees the
  // public landing page below instead of a redirect.
  const user = await getActiveUser(session);

  if (user) {
    if (user.role === "ADMIN") {
      redirect("/admin");
    }

    if (canUseInbox(user.role)) {
      redirect("/dashboard");
    }

    // ADVISOR / VALIDATOR are travel-only until W2.
    redirect("/travel");
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PublicHeader active="home" />
      <Hero />
      <HowItWorks />
      <Benefits />
      <ContactBlock />
      <PublicFooter />
    </main>
  );
}
