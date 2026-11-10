import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { hasPermission } from "@/lib/permissions";
import { canAccessTravel } from "@/lib/travel/access";
import NewRequestPage from "@/components/travel/NewRequestPage";

// Routed full-page "new travel request" (replaces the modal in the requests list).
// Same gates as POST /api/travel/requests: travel.access + travel.create and an
// ADMIN/ADVISOR role. Partners never reach it (they are redirected to /partner).
export default async function NewTravelRequestRoute() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (user.role === "PARTNER") redirect("/partner");
  if (!hasPermission(user, "travel.access")) redirect("/dashboard");
  if (!(await canAccessTravel(user.id, user.role))) redirect("/dashboard");
  if (!(user.role === "ADMIN" || user.role === "ADVISOR") || !hasPermission(user, "travel.create")) redirect("/travel");
  return <NewRequestPage />;
}
