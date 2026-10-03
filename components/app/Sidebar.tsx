"use client";

import type { JSX } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bell,
  Building2,
  Calculator,
  ClipboardList,
  Inbox,
  Library,
  LogOut,
  Menu,
  MessageSquare,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { PermissionKey } from "@/lib/permissions";
import { navGroupsForUser, type NavGroupModel, type NavIcon, type NavItemModel, type NavUser } from "@/components/app/nav";
import { BrandMark } from "@/components/app/BrandMark";

export interface SidebarProps {
  role: string;
  permissions: string[]; // effective PermissionKey values, serialized by the server shell
  userName: string | null;
  userEmail: string | null;
  version: string;
}

const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  "message-square": MessageSquare,
  inbox: Inbox,
  "clipboard-list": ClipboardList,
  library: Library,
  "building-2": Building2,
  settings: Settings,
  bell: Bell,
  calculator: Calculator,
  "shield-check": ShieldCheck,
  users: Users,
};

function initials(name: string | null, email: string | null): string {
  const src = name || email || "?";
  return src
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

function NavGroups({ groups, inSheet = false }: { groups: NavGroupModel[]; inSheet?: boolean }) {
  const pathname = usePathname();

  const link = (item: NavItemModel) => {
    const active = item.match(pathname);
    const Icon = NAV_ICONS[item.icon];
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
        <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground/70")} />
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

function UserCard({ role, userName, userEmail, version }: SidebarProps) {
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
          <p className="truncate text-xs text-muted-foreground">{role === "ADMIN" ? "Administrator" : role}</p>
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

function useNavGroups(props: SidebarProps): NavGroupModel[] {
  const user: NavUser = {
    role: props.role,
    permissions: new Set(props.permissions as PermissionKey[]),
  };
  return navGroupsForUser(user);
}

/**
 * W4 shared app shell sidebar — 240px grouped-icon sidebar, fixed on lg+.
 * The nav model comes from components/app/nav.ts (role/permission-driven);
 * active state is derived from the pathname. Below lg the sidebar collapses
 * into a Sheet opened from MobileBar.
 */
export function Sidebar(props: SidebarProps): JSX.Element {
  const groups = useNavGroups(props);
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r bg-card lg:flex">
      <div className="flex h-16 items-center border-b px-3">
        <BrandMark />
      </div>
      <NavGroups groups={groups} />
      <UserCard {...props} />
    </aside>
  );
}

export function MobileBar(props: SidebarProps): JSX.Element {
  const groups = useNavGroups(props);
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 lg:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-72 flex-col p-0" aria-describedby={undefined}>
          <SheetTitle className="sr-only">Portal navigation</SheetTitle>
          <div className="flex h-16 items-center border-b px-3">
            <BrandMark />
          </div>
          <NavGroups groups={groups} inSheet />
          <UserCard {...props} />
        </SheetContent>
      </Sheet>
      <BrandMark compact />
    </div>
  );
}
