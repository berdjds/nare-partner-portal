import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { accountPermissions, hasPermission } from "@/lib/permissions";
import { ensureDefaultAccounts, listAccounts } from "@/lib/whatsapp-accounts";
import ChatDashboard, { type DashboardAccount } from "@/components/dashboard/ChatDashboard";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/login");

  const user = await getActiveUser(session);
  if (!user) redirect("/login");

  // W3 per-account gate: the inbox shows every account whose view permission
  // the user holds (marhaba → whatsapp.inbox.view, nare → whatsapp.nare.view),
  // resolved from the current database row. Users who can view none are
  // redirected; unknown/deactivated sessions fall back to login above.
  await ensureDefaultAccounts();
  const all = await listAccounts();
  const accounts: DashboardAccount[] = all.flatMap((account) => {
    const perms = accountPermissions(account.key);
    if (!perms || !hasPermission(user, perms.view)) return [];
    return [
      {
        key: account.key,
        displayName: account.displayName,
        canSend: hasPermission(user, perms.send),
        canAdmin: hasPermission(user, perms.admin),
      },
    ];
  });
  if (accounts.length === 0) redirect("/travel");

  return (
    <ChatDashboard
      isAdminRole={user.role === "ADMIN"}
      accounts={accounts}
    />
  );
}
