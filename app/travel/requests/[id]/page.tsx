import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { canAccessTravel } from "@/lib/travel/access";
import RequestDetail from "@/components/travel/detail/RequestDetail";

export default async function TravelRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");
  if (!(await canAccessTravel(session.user.id, session.user.role))) redirect("/dashboard");

  return <RequestDetail requestId={id} role={session.user.role} userId={session.user.id} />;
}
