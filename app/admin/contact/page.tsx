import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import ContactAdmin from "@/components/admin/ContactAdmin";

export default async function ContactAdminPage() {
  const user = await getActiveUser(await getServerSession(authOptions));
  if (!user) redirect("/login");
  if (!hasPermission(user, "admin.settings")) redirect("/");
  return (
    <AppShell>
      <PageHeader title="Company and contact" subtitle="Public contact details with draft, publish and history. Global defaults apply everywhere; the portal override changes only the fields you set."
        breadcrumb={[{ label: "Admin panel", href: "/admin" }, { label: "Company and contact" }]} />
      <ContactAdmin />
    </AppShell>
  );
}
