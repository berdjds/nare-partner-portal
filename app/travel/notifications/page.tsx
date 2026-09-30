import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { isTravelRole } from "@/lib/travel/contracts";
import NotificationsList from "@/components/travel/NotificationsList";

export default async function TravelNotificationsPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!isTravelRole(user.role)) redirect("/dashboard");

  return <NotificationsList role={user.role} userId={user.id} />;
}
