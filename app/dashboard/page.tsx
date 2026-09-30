import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { canUseInbox, getActiveUser } from "@/lib/access-policy";
import ChatDashboard from "@/components/dashboard/ChatDashboard";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  // Interim W1 policy (lib/access-policy.ts): only ADMIN/USER may open the
  // inbox, decided from the current database role; travel-only roles are
  // redirected, unknown/deactivated sessions fall back to login.
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!canUseInbox(user.role)) redirect("/travel");

  return <ChatDashboard isAdmin={user.role === "ADMIN"} />;
}
