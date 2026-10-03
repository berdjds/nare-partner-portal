/**
 * Tests for the W4 "admin shell" change. The admin pages render inside the
 * shared AppShell (components/app/AppShell.tsx) with the shared PageHeader
 * instead of their own duplicated header chrome: app/admin/page.tsx and
 * app/admin/permissions/page.tsx keep their role/permission guards while
 * wrapping their content in <AppShell>, and components/admin/AdminDashboard.tsx
 * drops its duplicated header buttons (dashboard/calculator/travel/permissions
 * links, sign-out controls) and the old page wrapper, keeping its tabs and
 * panels. components/admin/AccountsPanel.tsx keeps the "Disabled" state badge.
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/travel-shell.test.ts (the suite runs in node, no DOM).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("W4 admin shell", () => {
  it("app/admin/page.tsx wraps the admin dashboard in the shared AppShell and keeps its guard", () => {
    const page = readRepoFile("app/admin/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain('import { PageHeader } from "@/components/app/PageHeader"');
    expect(page).toContain("<AppShell>");
    expect(page).toContain("<PageHeader");
    expect(page).toContain('user.role !== "ADMIN"');
    expect(page).toContain('redirect("/login")');
    expect(page).toContain("<AdminDashboard");
    expect(page).toContain("canAdminWhatsApp");
    expect(page).toContain("currentUserId");
  });

  it("app/admin/permissions/page.tsx uses the shared AppShell and drops the old wrapper chrome", () => {
    const page = readRepoFile("app/admin/permissions/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain('import { PageHeader } from "@/components/app/PageHeader"');
    expect(page).toContain("<AppShell>");
    expect(page).toContain('hasPermission(user, "admin.users")');
    expect(page).toMatch(/breadcrumb=(\{|\[)/);
    expect(page).toContain("<PermissionsReport />");
    expect(page).not.toContain("min-h-screen bg-muted/40");
    expect(page).not.toContain("← Back to admin panel");
  });

  it("AdminDashboard.tsx drops the duplicated header buttons and keeps its tabs and panels", () => {
    const dashboard = readRepoFile("components/admin/AdminDashboard.tsx");
    for (const removed of [
      'window.location.href = "/dashboard"',
      'window.location.href = "/calculator"',
      'window.location.href = "/travel"',
      'window.location.href = "/admin/permissions"',
      "Sign out everywhere",
      ">Sign out<",
      "handleSignOutEverywhere",
      'from "next-auth/react"',
      "min-h-screen bg-muted/40 p-4",
    ]) {
      expect(dashboard).not.toContain(removed);
    }
    expect(dashboard).toContain('TabsTrigger value="accounts"');
    expect(dashboard).toContain('TabsTrigger value="users"');
    expect(dashboard).toContain('TabsTrigger value="logs"');
    expect(dashboard).toContain("<AccountsPanel");
    expect(dashboard).toContain("<UserPermissionsDialog");
  });

  it("AccountsPanel.tsx keeps the Disabled state badge label", () => {
    const panel = readRepoFile("components/admin/AccountsPanel.tsx");
    expect(panel).toContain('"Disabled"');
  });
});
