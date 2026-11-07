"use client";

/**
 * Shared public site header (W5f, task pub-chrome) — the navigation chrome for
 * every public page (landing, partner application, sign in, legal pages).
 *
 * The shared BrandMark image sits beside the text wordmark. On small screens
 * the primary links collapse behind a menu button (aria-expanded /
 * aria-controls); Escape closes the menu. The active page is exposed with
 * aria-current="page".
 */

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { BrandMark } from "@/components/app/BrandMark";
import { PARTNER_APPLY, PRODUCT_NAME } from "@/lib/portal-content";

export type PublicPageKey = "home" | "apply" | "login";

const NAV_LINKS: readonly { key: PublicPageKey; href: string; label: string }[] = [
  { key: "home", href: "/", label: "Home" },
  { key: "apply", href: "/partners/apply", label: PARTNER_APPLY.linkLabel },
  { key: "login", href: "/login", label: "Sign in" },
];

export function PublicHeader({ active }: { active?: PublicPageKey }) {
  const [open, setOpen] = useState(false);

  return (
    <header
      className="border-b border-border bg-background"
      onKeyDown={(event) => {
        // Escape closes the mobile menu from anywhere inside the header.
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      <div className="mx-auto max-w-5xl px-6 py-4 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-center justify-between gap-x-3">
          <Link
            href="/"
            className="flex min-w-0 items-center gap-2.5 text-sm font-bold uppercase tracking-[0.2em] text-foreground sm:text-lg"
          >
            <BrandMark markOnly />
            <span className="whitespace-nowrap">{PRODUCT_NAME}</span>
          </Link>

          <button
            type="button"
            aria-expanded={open}
            aria-controls="public-header-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((visible) => !visible)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-muted sm:hidden"
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden="true" />
            ) : (
              <Menu className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
        </div>

        <nav
          id="public-header-nav"
          aria-label="Primary"
          className={`${
            open ? "flex" : "hidden"
          } mt-4 w-full flex-col gap-4 text-sm font-medium sm:mt-0 sm:flex sm:w-auto sm:flex-row sm:items-center sm:gap-6`}
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              aria-current={active === link.key ? "page" : undefined}
              className={
                active === link.key
                  ? "text-primary underline underline-offset-4"
                  : "text-muted-foreground hover:text-foreground"
              }
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
