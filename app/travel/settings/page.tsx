import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import SettingsPanel from "@/components/travel/SettingsPanel";

export default async function TravelSettingsPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/travel");

  return <SettingsPanel role={user.role} userId={user.id} />;
}
