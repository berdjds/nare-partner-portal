import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import TranslationsAdmin from "@/components/admin/TranslationsAdmin";

export default async function TranslationsAdminPage() {
  const user = await getActiveUser(await getServerSession(authOptions));
  if (!user) redirect("/login");
  const canTranslate = hasPermission(user, "content.translate");
  const canApprove = hasPermission(user, "content.approve");
  if (!canTranslate && !canApprove) redirect("/");
  return (
    <AppShell>
      <PageHeader title="Translations" subtitle="English is the source. Drafts, including AI-assisted ones, are published only after a person approves them."
        breadcrumb={[{ label: "Admin panel", href: "/admin" }, { label: "Translations" }]} />
      <TranslationsAdmin canTranslate={canTranslate} canApprove={canApprove} />
    </AppShell>
  );
}
