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
import { PRODUCT_NAME } from "@/lib/portal-content";
import { useT } from "@/lib/i18n/react";
import type { MessageKey } from "@/lib/i18n/messages";
import { LanguageSwitcher } from "./LanguageSwitcher";

export type PublicPageKey = "home" | "apply" | "login";

const NAV_LINKS: readonly { key: PublicPageKey; href: string; label: MessageKey }[] = [
  { key: "home", href: "/", label: "nav.home" },
  { key: "apply", href: "/partners/apply", label: "nav.apply" },
  { key: "login", href: "/login", label: "common.signIn" },
];

export function PublicHeader({ active }: { active?: PublicPageKey }) {
  const [open, setOpen] = useState(false);
  const t = useT();

  return (
    <header
      className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur"
      onKeyDown={(event) => {
        // Escape closes the mobile menu from anywhere inside the header.
        if (event.key === "Escape") {
          setOpen(false);
        }
      }}
    >
      <div className="mx-auto max-w-7xl px-6 py-3 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-center justify-between gap-3">
          {/* The one brand lockup on public pages: the approved script logo from staging.nare.am. */}
          <Link href="/" className="flex shrink-0 items-center" aria-label={PRODUCT_NAME}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/nare-logo.webp" alt={PRODUCT_NAME} width={118} height={56} className="h-12 w-auto sm:h-14" />
          </Link>

          <button
            type="button"
            aria-expanded={open}
            aria-controls="public-header-nav"
            aria-label={open ? t("nav.closeMenu") : t("nav.openMenu")}
            onClick={() => setOpen((visible) => !visible)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-foreground hover:bg-muted sm:hidden"
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
          aria-label={t("nav.primary")}
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
                link.key === "login"
                  ? "inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-primary-foreground shadow-sm transition hover:bg-primary/90"
                  : active === link.key
                    ? "text-brand underline decoration-2 underline-offset-8"
                    : "text-muted-foreground transition-colors hover:text-plum"
              }
            >
              {t(link.label)}
            </Link>
          ))}
          <LanguageSwitcher />
        </nav>
      </div>
    </header>
  );
}
