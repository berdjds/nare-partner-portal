import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import AppShell from "@/components/app/AppShell";
import { PageHeader } from "@/components/app/PageHeader";
import AdminDashboard from "@/components/admin/AdminDashboard";

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || user.role !== "ADMIN") {
    redirect("/login");
  }

  // The WhatsApp connection controls require the effective whatsapp.admin
  // permission; an admin denied the key still manages users but the server
  // already withholds the state details, QR and reconnect/logout actions.
  return (
    <AppShell>
      <PageHeader title="Admin Panel" subtitle="Manage WhatsApp connection, users, and logs." />
      <AdminDashboard canAdminWhatsApp={hasPermission(user, "whatsapp.admin")} currentUserId={user.id} />
    </AppShell>
  );
}
