import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import PermissionsReport from "@/components/admin/PermissionsReport";

export default async function PermissionsReportPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) {
    redirect("/login");
  }

  // User management (and with it the permission report) is gated on the
  // effective admin.users permission, matching the /api/permissions routes.
  if (!hasPermission(user, "admin.users")) {
    redirect("/");
  }

  return (
    <AppShell>
      <PageHeader
        title="Proposed permissions"
        subtitle="Review the role-preset permissions each existing user would receive, then confirm the migration."
        breadcrumb={[
          { label: "Admin panel", href: "/admin" },
          { label: "Permissions report" },
        ]}
      />
      <PermissionsReport />
    </AppShell>
  );
}
