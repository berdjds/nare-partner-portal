/**
 * W4 shared navigation model.
 *
 * navGroupsForUser() is a PURE function of (role, effective permissions) — no
 * React, no JSX, no next/* or prisma imports — so server components, client
 * components and node-environment Vitest tests can all consume it.
 *
 * Every visibility predicate mirrors exactly the guard of the page it links
 * to today (cited inline per item), expressed through the same helpers the
 * pages use: lib/access-policy.ts's getActiveUser for session validity and
 * lib/permissions.ts's hasPermission over the effective permission set
 * (role preset + per-user overrides, see effectivePermissions).
 *
 * IMPORTANT: the page guards remain the enforcement. This model only decides
 * which links the UI shows or hides; a denied link is cosmetic, a denied page
 * redirect is security.
 */

import { hasPermission, type PermissionKey } from "@/lib/permissions";
import { isTravelRole } from "@/lib/travel/contracts";

export type NavIcon =
  | "message-square" | "inbox" | "clipboard-list" | "library" | "building-2"
  | "settings" | "bell" | "calculator" | "shield-check" | "users";

export interface NavItemModel {
  href: string;
  label: string;
  icon: NavIcon;
  match: (pathname: string) => boolean;
}

export interface NavGroupModel {
  label: string;
  items: NavItemModel[];
}

export interface NavUser {
  role: string;
  permissions: ReadonlySet<PermissionKey>;
}

/**
 * Returns the visible navigation groups for a user, in the fixed order
 * Inbox → Travel → Tools → Admin. null/undefined (no active session) yields
 * no groups at all; a group whose items are all invisible is dropped.
 */
export function navGroupsForUser(user: NavUser | null | undefined): NavGroupModel[] {
  if (!user) return [];

  const groups: NavGroupModel[] = [];

  // --- Inbox ---------------------------------------------------------------
  const inboxItems: NavItemModel[] = [];
  // Mirrors app/dashboard/page.tsx: the dashboard lists every account whose
  // view permission the user holds (marhaba → whatsapp.inbox.view, nare →
  // whatsapp.nare.view via accountPermissions()) and redirects away when the
  // user can view none — so the link shows iff either view key is held.
  if (hasPermission(user, "whatsapp.inbox.view") || hasPermission(user, "whatsapp.nare.view")) {
    inboxItems.push({
      href: "/dashboard",
      label: "Chat dashboard",
      icon: "message-square",
      match: (p) => p === "/dashboard" || p.startsWith("/dashboard/"),
    });
  }
  if (inboxItems.length > 0) groups.push({ label: "Inbox", items: inboxItems });

  // --- Travel --------------------------------------------------------------
  const travelItems: NavItemModel[] = [];
  // Mirrors app/travel/page.tsx and app/travel/review/page.tsx: both require
  // the effective travel.access permission AND canAccessTravel() from
  // lib/travel/access.ts. canAccessTravel's role branch (isTravelRole) is
  // subsumed here because only travel-role presets hold travel.access; its
  // validation-assignment branch is a runtime DB check that stays on the page
  // and cannot be part of this pure model.
  if (hasPermission(user, "travel.access")) {
    travelItems.push(
      {
        href: "/travel",
        label: "Requests",
        icon: "inbox",
        match: (p) => p === "/travel" || p.startsWith("/travel/requests"),
      },
      {
        href: "/travel/review",
        label: "Review queue",
        icon: "clipboard-list",
        match: (p) => p.startsWith("/travel/review"),
      },
    );
  }
  // Mirrors app/travel/templates/page.tsx: if (!isTravelRole(user.role)) redirect("/dashboard").
  if (isTravelRole(user.role)) {
    travelItems.push({
      href: "/travel/templates",
      label: "Templates",
      icon: "library",
      match: (p) => p.startsWith("/travel/templates"),
    });
  }
  // Mirrors app/travel/catalog/page.tsx, app/travel/agencies/page.tsx and
  // app/travel/settings/page.tsx: if (user.role !== "ADMIN") redirect("/travel").
  if (user.role === "ADMIN") {
    travelItems.push(
      {
        href: "/travel/catalog",
        label: "Catalog",
        icon: "building-2",
        match: (p) => p.startsWith("/travel/catalog"),
      },
      {
        href: "/travel/agencies",
        label: "Agencies",
        icon: "building-2",
        match: (p) => p.startsWith("/travel/agencies"),
      },
      {
        href: "/travel/settings",
        label: "Settings",
        icon: "settings",
        match: (p) => p.startsWith("/travel/settings"),
      },
    );
  }
  // Mirrors app/travel/notifications/page.tsx: if (!isTravelRole(user.role)) redirect("/dashboard").
  if (isTravelRole(user.role)) {
    travelItems.push({
      href: "/travel/notifications",
      label: "Notifications",
      icon: "bell",
      match: (p) => p.startsWith("/travel/notifications"),
    });
  }
  if (travelItems.length > 0) groups.push({ label: "Travel", items: travelItems });

  // --- Tools ---------------------------------------------------------------
  // app/calculator/page.tsx guards only on getActiveUser — any active user
  // may open it, so the link is always visible here.
  groups.push({
    label: "Tools",
    items: [
      {
        href: "/calculator",
        label: "Calculator",
        icon: "calculator",
        match: (p) => p === "/calculator" || p.startsWith("/calculator/"),
      },
    ],
  });

  // --- Admin ---------------------------------------------------------------
  const adminItems: NavItemModel[] = [];
  // Mirrors app/admin/page.tsx: if (!user || user.role !== "ADMIN") redirect.
  // Exact match only — must NOT highlight while on /admin/permissions.
  if (user.role === "ADMIN") {
    adminItems.push({
      href: "/admin",
      label: "Accounts and users panel",
      icon: "shield-check",
      match: (p) => p === "/admin",
    });
  }
  // Mirrors app/admin/permissions/page.tsx: if (!hasPermission(user, "admin.users")) redirect.
  if (hasPermission(user, "admin.users")) {
    adminItems.push({
      href: "/admin/permissions",
      label: "Permissions report",
      icon: "users",
      match: (p) => p.startsWith("/admin/permissions"),
    });
  }
  // Mirrors app/admin/partners/page.tsx: if (!hasPermission(user, "partners.review")) redirect.
  if (hasPermission(user, "partners.review")) {
    adminItems.push({
      href: "/admin/partners",
      label: "Partner applications",
      icon: "building-2",
      match: (p) => p.startsWith("/admin/partners"),
    });
  }
  if (adminItems.length > 0) groups.push({ label: "Admin", items: adminItems });

  return groups;
}
