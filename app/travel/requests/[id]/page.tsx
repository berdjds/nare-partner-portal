import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { canAccessTravel } from "@/lib/travel/access";
import RequestDetail from "@/components/travel/detail/RequestDetail";

export default async function TravelRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!(await canAccessTravel(user.id, user.role))) redirect("/dashboard");

  return <RequestDetail requestId={id} role={user.role} userId={user.id} />;
}
