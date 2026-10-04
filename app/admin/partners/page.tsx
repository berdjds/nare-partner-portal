import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import ReviewQueue from "@/components/partners/ReviewQueue";

export default async function PartnerApplicationsPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) {
    redirect("/login");
  }

  // The review queue is gated on partners.review, matching the
  // /api/admin/partners routes.
  if (!hasPermission(user, "partners.review")) {
    redirect("/");
  }

  return (
    <AppShell>
      <PageHeader
        title="Partner applications"
        subtitle="Review new B2B partner applications and their trade licences."
        breadcrumb={[
          { label: "Admin panel", href: "/admin" },
          { label: "Partner applications" },
        ]}
      />
      <ReviewQueue />
    </AppShell>
  );
}
