import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import ChatDashboard from "@/components/dashboard/ChatDashboard";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  // W2 permission policy: opening the inbox requires the effective
  // whatsapp.inbox.view permission, resolved from the current database row;
  // users without it are redirected, unknown/deactivated sessions fall back
  // to login.
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!hasPermission(user, "whatsapp.inbox.view")) redirect("/travel");

  return (
    <ChatDashboard
      isAdminRole={user.role === "ADMIN"}
      canSend={hasPermission(user, "whatsapp.inbox.send")}
      canAdminWhatsApp={hasPermission(user, "whatsapp.admin")}
    />
  );
}
