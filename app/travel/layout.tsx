import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { getActiveUser } from "@/lib/access-policy";
import { TravelMobileBar, TravelSidebar } from "@/components/travel/TravelSidebar";
import pkg from "@/package.json";

/**
 * Travel module route layout (v0.13.0): sidebar app shell. The 240px sidebar
 * is fixed on lg+ and the content column is offset with lg:pl-60; below lg a
 * slim top bar with a Sheet-based nav takes over. Pages still guard
 * themselves (redirect on no session / no travel access); the chrome simply
 * hides when there is no session, or when the session is revoked or stale —
 * getActiveUser() re-reads the user row, so the chrome reflects the current
 * database role.
 */
export default async function TravelLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  const user = await getActiveUser(session);
  const navProps = user
    ? {
        role: user.role,
        userName: user.name,
        userEmail: user.email,
        version: pkg.version,
      }
    : null;

  return (
    <div className="min-h-screen bg-background">
      {navProps && <TravelSidebar {...navProps} />}
      <div className={navProps ? "lg:pl-60" : undefined}>
        {navProps && <TravelMobileBar {...navProps} />}
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
