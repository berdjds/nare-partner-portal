import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import AdminDashboard from "@/components/admin/AdminDashboard";

export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user || user.role !== "ADMIN") {
    redirect("/login");
  }

  return <AdminDashboard />;
}
