import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { isTravelRole } from "@/lib/travel/contracts";
import TemplateEditor from "@/components/travel/TemplateEditor";

export default async function TravelTemplateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  if (!isTravelRole(session.user.role)) redirect("/dashboard");
  // Template edits silently shape every future instantiate — ADMIN only
  // (matches the PUT route's role check).
  if (session.user.role !== "ADMIN") redirect("/travel/templates");

  return <TemplateEditor templateId={id} role={session.user.role} />;
}
