import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { isTravelRole } from "@/lib/travel/contracts";
import TemplateEditor from "@/components/travel/TemplateEditor";

export default async function TravelTemplateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!isTravelRole(user.role)) redirect("/dashboard");
  // Template edits silently shape every future instantiate — ADMIN only
  // (matches the PUT route's role check).
  if (user.role !== "ADMIN") redirect("/travel/templates");

  return <TemplateEditor templateId={id} role={user.role} />;
}
