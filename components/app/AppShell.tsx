import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { MobileBar, Sidebar, type SidebarProps } from "@/components/app/Sidebar";
import pkg from "@/package.json";

export type AppShellVariant = "default" | "full";

/**
 * W4 shared app shell. Pages wrap themselves explicitly (<AppShell>...</AppShell>)
 * instead of a route-group layout, so any page can opt into the shared chrome.
 * The chrome hides when there is no active user — pages guard themselves;
 * getActiveUser() re-reads the user row, so revocation or a role change takes
 * effect on the next request. Variant "full" drops the centered max-width
 * container for pages that need the whole content width (chat dashboard).
 */
export default async function AppShell({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: AppShellVariant;
}) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  if (!user) return <>{children}</>;

  const navProps: SidebarProps = {
    role: user.role,
    permissions: Array.from(user.permissions),
    userName: user.name,
    userEmail: user.email,
    version: pkg.version,
  };

  return (
    <div className="min-h-screen bg-background">
      <Sidebar {...navProps} />
      <div className="lg:pl-60">
        <MobileBar {...navProps} />
        <main
          className={
            variant === "full" ? "w-full" : "mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8"
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
