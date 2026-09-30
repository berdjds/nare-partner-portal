import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import AgenciesAdmin from "@/components/travel/AgenciesAdmin";

export default async function TravelAgenciesPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/travel");

  return <AgenciesAdmin role={user.role} />;
}
