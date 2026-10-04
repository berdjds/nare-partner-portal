/**
 * Tests for the W4 shared navigation model (components/app/nav.ts). Every
 * permission set is built with effectivePermissions() — the exact helper
 * getActiveUser uses — so these tests exercise the real guard resolution,
 * not a reimplementation.
 */

import { describe, expect, it } from "vitest";
import { effectivePermissions, type PermissionOverride } from "@/lib/permissions";
import { navGroupsForUser, type NavUser } from "@/components/app/nav";

function user(role: string, overrides: PermissionOverride[] = []): NavUser {
  return { role, permissions: effectivePermissions(role, overrides) };
}

function groupLabels(groups: ReturnType<typeof navGroupsForUser>): string[] {
  return groups.map((g) => g.label);
}

function itemLabels(groups: ReturnType<typeof navGroupsForUser>, groupLabel: string): string[] {
  return groups.find((g) => g.label === groupLabel)?.items.map((i) => i.label) ?? [];
}

describe("navGroupsForUser", () => {
  it("returns no groups for null/undefined (no access)", () => {
    expect(navGroupsForUser(null)).toEqual([]);
    expect(navGroupsForUser(undefined)).toEqual([]);
  });

  it("ADMIN sees Inbox, Travel, Tools, Admin in order, with the full spec contract", () => {
    // ADMIN holds every permission key (ROLE_PRESETS: ADMIN = all of PERMISSION_KEYS).
    const groups = navGroupsForUser(user("ADMIN"));
    expect(groupLabels(groups)).toEqual(["Inbox", "Travel", "Tools", "Admin"]);

    // Pin the exact href/label/icon triple the Sidebar renders.
    const shape = groups.map((g) => ({
      label: g.label,
      items: g.items.map(({ href, label, icon }) => ({ href, label, icon })),
    }));
    expect(shape).toEqual([
      {
        label: "Inbox",
        items: [{ href: "/dashboard", label: "Chat dashboard", icon: "message-square" }],
      },
      {
        label: "Travel",
        items: [
          { href: "/travel", label: "Requests", icon: "inbox" },
          { href: "/travel/review", label: "Review queue", icon: "clipboard-list" },
          { href: "/travel/templates", label: "Templates", icon: "library" },
          { href: "/travel/catalog", label: "Catalog", icon: "building-2" },
          { href: "/travel/agencies", label: "Agencies", icon: "building-2" },
          { href: "/travel/settings", label: "Settings", icon: "settings" },
          { href: "/travel/notifications", label: "Notifications", icon: "bell" },
        ],
      },
      {
        label: "Tools",
        items: [{ href: "/calculator", label: "Calculator", icon: "calculator" }],
      },
      {
        label: "Admin",
        items: [
          { href: "/admin", label: "Accounts and users panel", icon: "shield-check" },
          { href: "/admin/permissions", label: "Permissions report", icon: "users" },
          { href: "/admin/partners", label: "Partner applications", icon: "building-2" },
        ],
      },
    ]);
  });

  it("USER sees Inbox (Chat dashboard) + Tools only", () => {
    // USER preset holds whatsapp.inbox.view (lib/permissions.ts ROLE_PRESETS),
    // satisfying the app/dashboard/page.tsx per-account view-permission guard;
    // USER is not a travel role and not ADMIN, so no Travel/Admin groups.
    const groups = navGroupsForUser(user("USER"));
    expect(groupLabels(groups)).toEqual(["Inbox", "Tools"]);
    expect(itemLabels(groups, "Inbox")).toEqual(["Chat dashboard"]);
    expect(itemLabels(groups, "Tools")).toEqual(["Calculator"]);
  });

  it("USER with nare-only inbox access (marhaba view denied) still sees the Inbox link", () => {
    // Genuine nare-only isolation: the USER preset's whatsapp.inbox.view is
    // explicitly denied, so the Inbox group can only come from the
    // whatsapp.nare.view branch of the OR in components/app/nav.ts.
    // app/dashboard/page.tsx keeps every account whose view permission the
    // user holds and redirects only when none remain: the per-account view
    // keys (marhaba → whatsapp.inbox.view, nare → whatsapp.nare.view) are
    // independent, and the nare grant alone already keeps the Inbox visible.
    const groups = navGroupsForUser(
      user("USER", [
        { key: "whatsapp.inbox.view", allowed: false },
        { key: "whatsapp.nare.view", allowed: true },
      ]),
    );
    expect(groupLabels(groups)).toEqual(["Inbox", "Tools"]);
    expect(itemLabels(groups, "Inbox")).toEqual(["Chat dashboard"]);
  });

  it("ADVISOR granted only whatsapp.nare.view also sees the Inbox link", () => {
    // Second isolation angle: the ADVISOR preset holds no whatsapp.* keys at
    // all, so the nare grant is the sole possible source of the Inbox group.
    const groups = navGroupsForUser(
      user("ADVISOR", [{ key: "whatsapp.nare.view", allowed: true }]),
    );
    expect(groupLabels(groups)).toContain("Inbox");
    expect(itemLabels(groups, "Inbox")).toEqual(["Chat dashboard"]);
  });

  it("USER denied both view keys loses the Inbox link", () => {
    // Negative counterpart: with neither whatsapp.inbox.view nor
    // whatsapp.nare.view effective, app/dashboard/page.tsx redirects away and
    // the Inbox group must disappear.
    const groups = navGroupsForUser(
      user("USER", [{ key: "whatsapp.inbox.view", allowed: false }]),
    );
    expect(groupLabels(groups)).toEqual(["Tools"]);
  });

  it("ADVISOR sees Travel [Requests, Review queue, Templates, Notifications] + Tools", () => {
    // ADVISOR preset holds travel.access (app/travel/page.tsx and
    // app/travel/review/page.tsx guards) and is a travel role
    // (app/travel/templates/page.tsx, app/travel/notifications/page.tsx);
    // the ADMIN-only pages (catalog/agencies/settings) stay hidden.
    const groups = navGroupsForUser(user("ADVISOR"));
    expect(groupLabels(groups)).toEqual(["Travel", "Tools"]);
    expect(itemLabels(groups, "Travel")).toEqual([
      "Requests",
      "Review queue",
      "Templates",
      "Notifications",
    ]);
  });

  it("VALIDATOR sees the same visible set as ADVISOR", () => {
    // VALIDATOR preset also holds travel.access and is a travel role — same
    // four travel pages plus Tools.
    const advisor = navGroupsForUser(user("ADVISOR"));
    const validator = navGroupsForUser(user("VALIDATOR"));
    const strip = (groups: typeof advisor) =>
      groups.map((g) => ({ label: g.label, items: g.items.map((i) => i.href) }));
    expect(strip(validator)).toEqual(strip(advisor));
    expect(itemLabels(validator, "Travel")).toEqual([
      "Requests",
      "Review queue",
      "Templates",
      "Notifications",
    ]);
  });

  it("ADVISOR denied travel.access keeps only the role-gated travel pages", () => {
    // Denying travel.access hides the permission-gated pages
    // (app/travel/page.tsx, app/travel/review/page.tsx) but ADVISOR is still a
    // travel role, so the isTravelRole-gated pages
    // (app/travel/templates/page.tsx, app/travel/notifications/page.tsx) remain.
    const groups = navGroupsForUser(user("ADVISOR", [{ key: "travel.access", allowed: false }]));
    expect(groupLabels(groups)).toEqual(["Travel", "Tools"]);
    expect(itemLabels(groups, "Travel")).toEqual(["Templates", "Notifications"]);
  });

  it("ADMIN denied admin.users loses the permissions report but keeps role-gated and partners.review items", () => {
    // app/admin/page.tsx is role-gated (ADMIN) and stays visible; the
    // permissions report is permission-gated (app/admin/permissions/page.tsx
    // requires hasPermission(user, "admin.users")) and drops out; partner
    // applications are gated on partners.review (app/admin/partners/page.tsx),
    // which a plain ADMIN preset still holds.
    const groups = navGroupsForUser(user("ADMIN", [{ key: "admin.users", allowed: false }]));
    expect(groupLabels(groups)).toEqual(["Inbox", "Travel", "Tools", "Admin"]);
    expect(itemLabels(groups, "Admin")).toEqual(["Accounts and users panel", "Partner applications"]);
  });

  it("ADMIN denied partners.review loses the Partner applications link (W5b)", () => {
    // app/admin/partners/page.tsx requires hasPermission(user, "partners.review");
    // denying it must hide the link even though the other admin pages stay.
    const groups = navGroupsForUser(user("ADMIN", [{ key: "partners.review", allowed: false }]));
    expect(itemLabels(groups, "Admin")).toEqual(["Accounts and users panel", "Permissions report"]);
  });

  it("non-admin granted partners.review sees an Admin group with only Partner applications", () => {
    // The partners.review gate is purely permission-based (a non-admin granted
    // the key may review, per lib/partners/review.ts requirePartnerReviewer),
    // while the Accounts panel stays role-gated — so the group appears with a
    // single item.
    const groups = navGroupsForUser(user("VALIDATOR", [{ key: "partners.review", allowed: true }]));
    expect(groupLabels(groups)).toEqual(["Travel", "Tools", "Admin"]);
    expect(itemLabels(groups, "Admin")).toEqual(["Partner applications"]);
  });

  it("unknown role sees only Tools (Calculator visible to any active user)", () => {
    // Unknown roles get the empty preset (presetForRole) and pass no gate;
    // app/calculator/page.tsx guards only on getActiveUser, so Calculator stays.
    const groups = navGroupsForUser(user("GHOST"));
    expect(groupLabels(groups)).toEqual(["Tools"]);
    expect(itemLabels(groups, "Tools")).toEqual(["Calculator"]);
  });

  it("match functions: /admin is exact, Requests covers /travel and /travel/requests/*", () => {
    const groups = navGroupsForUser(user("ADMIN"));
    const admin = groups.find((g) => g.label === "Admin")!.items.find((i) => i.href === "/admin")!;
    expect(admin.match("/admin")).toBe(true);
    expect(admin.match("/admin/permissions")).toBe(false);
    expect(admin.match("/admin/partners")).toBe(false);

    const partners = groups.find((g) => g.label === "Admin")!.items.find((i) => i.href === "/admin/partners")!;
    expect(partners.match("/admin/partners")).toBe(true);
    expect(partners.match("/admin/partners/abc123")).toBe(true);
    expect(partners.match("/admin")).toBe(false);

    const requests = groups.find((g) => g.label === "Travel")!.items.find((i) => i.href === "/travel")!;
    expect(requests.match("/travel")).toBe(true);
    expect(requests.match("/travel/requests/abc")).toBe(true);
    expect(requests.match("/travel/review")).toBe(false);
  });
});
