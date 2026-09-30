"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bell,
  Building2,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  Library,
  LogOut,
  Menu,
  MessageSquare,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  match: (p: string) => boolean;
  adminOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Work",
    items: [
      {
        href: "/travel",
        label: "Requests",
        icon: Inbox,
        match: (p) => p === "/travel" || p.startsWith("/travel/requests"),
      },
      { href: "/travel/review", label: "Review queue", icon: ClipboardList, match: (p) => p.startsWith("/travel/review") },
    ],
  },
  {
    label: "Library",
    items: [
      { href: "/travel/templates", label: "Templates", icon: Library, match: (p) => p.startsWith("/travel/templates") },
      { href: "/travel/catalog", label: "Catalog", icon: Building2, match: (p) => p.startsWith("/travel/catalog"), adminOnly: true },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/travel/agencies", label: "Agencies", icon: Building2, match: (p) => p.startsWith("/travel/agencies"), adminOnly: true },
      { href: "/travel/settings", label: "Settings", icon: Settings, match: (p) => p.startsWith("/travel/settings"), adminOnly: true },
      { href: "/travel/notifications", label: "Notifications", icon: Bell, match: (p) => p.startsWith("/travel/notifications"), adminOnly: true },
    ],
  },
];

// Notifications is the one admin-group page non-admin travel roles can open
// (its page guard allows any travel role), so it is appended to Work for them.
const NOTIFICATIONS_ITEM: NavItem = {
  href: "/travel/notifications",
  label: "Notifications",
  icon: Bell,
  match: (p) => p.startsWith("/travel/notifications"),
};

interface TravelNavProps {
  role: string;
  userName: string | null;
  userEmail: string | null;
  version: string;
}

function initials(name: string | null, email: string | null): string {
  const src = name || email || "?";
  return src
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

function Brand() {
  return (
    <Link href="/travel" className="flex items-center gap-2.5 px-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
        W
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">WAControl</span>
        <span className="block text-xs text-muted-foreground">Travel module</span>
      </span>
    </Link>
  );
}

function NavGroups({ role, inSheet = false }: { role: string; inSheet?: boolean }) {
  const pathname = usePathname();
  const isAdmin = role === "ADMIN";
  const groups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.adminOnly || isAdmin),
  })).filter((g) => g.items.length > 0);
  if (!isAdmin) {
    groups[0] = { ...groups[0], items: [...groups[0].items, NOTIFICATIONS_ITEM] };
  }

  const link = (item: NavItem) => {
    const active = item.match(pathname);
    return (
      <Link
        href={item.href}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
          active
            ? "bg-primary/[0.08] text-primary"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground/70")} />
        {item.label}
      </Link>
    );
  };

  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {group.label}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) =>
              inSheet ? (
                <SheetClose asChild key={item.href}>
                  {link(item)}
                </SheetClose>
              ) : (
                <div key={item.href}>{link(item)}</div>
              )
            )}
          </div>
        </div>
      ))}
    </nav>
  );
}

function FooterLinks({ role, inSheet = false }: { role: string; inSheet?: boolean }) {
  const items = [
    { href: "/dashboard", label: "Chat dashboard", icon: MessageSquare },
    ...(role === "ADMIN" ? [{ href: "/admin", label: "Admin panel", icon: ShieldCheck }] : []),
  ];
  return (
    <div className="flex flex-col gap-0.5 border-t px-3 py-3">
      {items.map((item) => {
        const el = (
          <Link
            href={item.href}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <item.icon className="h-4 w-4 shrink-0 text-muted-foreground/70" />
            {item.label}
          </Link>
        );
        return inSheet ? (
          <SheetClose asChild key={item.href}>
            {el}
          </SheetClose>
        ) : (
          <div key={item.href}>{el}</div>
        );
      })}
    </div>
  );
}

function UserCard({ role, userName, userEmail, version }: TravelNavProps) {
  return (
    <div className="border-t p-3">
      <div className="flex items-center gap-2.5 rounded-lg p-1.5">
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
            {initials(userName, userEmail)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[13px] font-medium">{userName || userEmail}</p>
          <p className="truncate text-xs text-muted-foreground">{role === "ADMIN" ? "Administrator" : "Agent"}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground"
          aria-label="Sign out"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 h-7 w-full justify-start px-2.5 text-[11px] font-normal text-muted-foreground"
        onClick={async () => {
          try {
            await fetch("/api/auth/sign-out-everywhere", { method: "POST" });
          } catch {
            // Best effort: the local sign-out below still ends this session.
          }
          signOut({ callbackUrl: "/login" });
        }}
      >
        Sign out everywhere
      </Button>
      <p className="px-2.5 pt-1 text-[11px] text-muted-foreground/60">v{version}</p>
    </div>
  );
}

/**
 * Travel module app shell (v0.13.0) — 240px grouped-icon sidebar replacing the
 * v0.12 top pill nav. Rendered once by app/travel/layout.tsx; active state is
 * derived from the pathname. Below lg the sidebar collapses into a Sheet
 * opened from TravelMobileBar.
 */
export function TravelSidebar(props: TravelNavProps) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card lg:flex">
      <div className="flex h-16 items-center border-b px-3">
        <Brand />
      </div>
      <NavGroups role={props.role} />
      <FooterLinks role={props.role} />
      <UserCard {...props} />
    </aside>
  );
}

export function TravelMobileBar(props: TravelNavProps) {
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 lg:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-72 flex-col p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Travel navigation</SheetTitle>
          <div className="flex h-16 items-center border-b px-3">
            <Brand />
          </div>
          <NavGroups role={props.role} inSheet />
          <FooterLinks role={props.role} inSheet />
          <UserCard {...props} />
        </SheetContent>
      </Sheet>
      <Link href="/travel" className="flex items-center gap-2">
        <LayoutDashboard className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold tracking-tight">WAControl Travel</span>
      </Link>
    </div>
  );
}
