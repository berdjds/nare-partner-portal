import Link from "next/link";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
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
    <div className="min-h-screen bg-muted/40 p-4">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Proposed permissions</h1>
        <p className="text-sm text-muted-foreground">
          Review the role-preset permissions each existing user would receive, then confirm the migration.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/admin" className="text-primary underline-offset-4 hover:underline">
            ← Back to admin panel
          </Link>
        </p>
      </header>
      <PermissionsReport />
    </div>
  );
}
