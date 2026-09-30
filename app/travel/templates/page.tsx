import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { isTravelRole } from "@/lib/travel/contracts";
import TemplatesList from "@/components/travel/TemplatesList";

export default async function TravelTemplatesPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!isTravelRole(user.role)) redirect("/dashboard");

  return <TemplatesList role={user.role} userId={user.id} />;
}
