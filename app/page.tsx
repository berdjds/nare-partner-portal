import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { canUseInbox, getActiveUser } from "@/lib/access-policy";

export default async function HomePage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/login");
  }

  // Interim W1 policy (lib/access-policy.ts): the role is re-read from the
  // database, so deactivation takes effect on the next request. A session
  // whose user row is gone or inactive counts as signed out.
  const user = await getActiveUser(session);
  if (!user) {
    redirect("/login");
  }

  if (user.role === "ADMIN") {
    redirect("/admin");
  }

  if (canUseInbox(user.role)) {
    redirect("/dashboard");
  }

  // ADVISOR / VALIDATOR are travel-only until W2.
  redirect("/travel");
}
