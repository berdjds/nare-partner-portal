import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import ReviewDetail from "@/components/partners/ReviewDetail";

export default async function PartnerApplicationReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) {
    redirect("/login");
  }

  if (!hasPermission(user, "partners.review")) {
    redirect("/");
  }

  const { id } = await params;

  return (
    <AppShell>
      <PageHeader
        title="Application review"
        subtitle="Check the company details and trade licence, then record your decision."
        breadcrumb={[
          { label: "Admin panel", href: "/admin" },
          { label: "Partner applications", href: "/admin/partners" },
          { label: "Application review" },
        ]}
      />
      <ReviewDetail applicationId={id} />
    </AppShell>
  );
}
