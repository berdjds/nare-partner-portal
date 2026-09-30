import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { canAccessTravel } from "@/lib/travel/access";
import ReviewQueue from "@/components/travel/ReviewQueue";

export default async function TravelReviewPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) redirect("/login");
  if (!(await canAccessTravel(user.id, user.role))) redirect("/dashboard");

  return <ReviewQueue role={user.role} userId={user.id} />;
}
