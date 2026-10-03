/**
 * Tests for the W4 "chat shell" change. The chat dashboard page renders
 * inside the shared AppShell (components/app/AppShell.tsx) instead of its own
 * header chrome: app/dashboard/page.tsx keeps its guards and account logic
 * while wrapping <ChatDashboard> in <AppShell variant="full">, and
 * components/dashboard/ChatDashboard.tsx drops its old header (WAControl
 * title, admin/calculator/travel nav buttons, sign-out control) in favour of
 * a slim toolbar, keeping the account switcher, the "New message" composer,
 * the connection/status badges, and the two-pane chat layout sized to fill
 * the viewport below the shell's 3.5rem mobile bar.
 *
 * These are source-text assertions via readFileSync — the same pattern as
 * tests/ui/admin-shell.test.ts (the suite runs in node, no DOM).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("W4 chat shell", () => {
  it("app/dashboard/page.tsx wraps the chat dashboard in AppShell variant full and keeps its guards", () => {
    const page = readRepoFile("app/dashboard/page.tsx");
    expect(page).toContain('import AppShell from "@/components/app/AppShell"');
    expect(page).toContain('<AppShell variant="full">');
    expect(page).toContain("<ChatDashboard");
    expect(page).toContain('redirect("/login")');
    expect(page).toContain('redirect("/travel")');
    expect(page).toContain("ensureDefaultAccounts");
    expect(page).not.toContain("isAdminRole");
  });

  it("ChatDashboard.tsx replaces the header with a slim toolbar and drops navigation and sign-out controls", () => {
    const dashboard = readRepoFile("components/dashboard/ChatDashboard.tsx");
    for (const removed of [
      'window.location.href = "/admin"',
      'window.location.href = "/calculator"',
      'window.location.href = "/travel"',
      "signOut",
      "disconnectSocket",
      "LogOut",
      "isAdminRole",
      "WAControl",
      "Sign out",
    ]) {
      expect(dashboard).not.toContain(removed);
    }
    expect(dashboard).toContain("AccountSwitcher");
    expect(dashboard).toContain("New message");
    expect(dashboard).toContain("Socket connected");
    expect(dashboard).toContain("Socket offline");
    expect(dashboard).toContain("Session expired");
    expect(dashboard).toContain("Not connected");
    expect(dashboard).toContain('accountState?.state || "initializing"');
    expect(dashboard).toContain("md:max-w-sm");
    expect(dashboard).toContain("Select a chat to start messaging");
    expect(dashboard).toContain("h-[calc(100dvh-3.5rem)]");
    expect(dashboard).toContain("lg:h-dvh");
  });

  it("socket and chat logic hooks are untouched", () => {
    const dashboard = readRepoFile("components/dashboard/ChatDashboard.tsx");
    expect(dashboard).toContain("useSocket()");
    expect(dashboard).toContain("lastEvent");
    expect(dashboard).toContain("chat_update");
    expect(dashboard).toContain("fetchChats");
    expect(dashboard).toContain("handleSend");
    expect(dashboard).toContain("/api/chats?account=");
    expect(dashboard).toContain("/api/send");
  });
});
