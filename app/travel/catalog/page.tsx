import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import CatalogAdmin from "@/components/travel/CatalogAdmin";

export default async function TravelCatalogPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (user.role !== "ADMIN") redirect("/travel");

  return <CatalogAdmin role={user.role} userId={user.id} />;
}
