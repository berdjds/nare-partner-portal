/**
 * Shared public site footer (W5f, task pub-chrome) — legal links (Terms,
 * Privacy), the contact email and phones from CONTACT, the office address
 * from OFFICE_ADDRESS and the copyright line. Token-only colours; no
 * client-side interactivity, so it can render from server and client pages.
 */

import Link from "next/link";
import { CONTACT, OFFICE_ADDRESS, PRODUCT_NAME } from "@/lib/portal-content";

export function PublicFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{PRODUCT_NAME}</p>
          <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
            {OFFICE_ADDRESS}
          </p>
        </div>

        <div className="space-y-2 text-sm">
          <p>
            <a
              href={`mailto:${CONTACT.email}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              {CONTACT.email}
            </a>
          </p>
          {CONTACT.phones.map((phone) => (
            <p key={phone}>
              <a
                href={`tel:${phone.replace(/\s/g, "")}`}
                className="text-muted-foreground underline-offset-4 hover:text-foreground"
              >
                {phone}
              </a>
            </p>
          ))}
        </div>

        <nav aria-label="Legal" className="flex flex-col gap-2 text-sm">
          <Link
            href="/terms"
            className="text-muted-foreground underline-offset-4 hover:text-foreground"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="text-muted-foreground underline-offset-4 hover:text-foreground"
          >
            Privacy
          </Link>
        </nav>
      </div>

      <div className="border-t border-border">
        <p className="mx-auto max-w-5xl px-6 py-4 text-xs text-muted-foreground">
          © {year} {PRODUCT_NAME}. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
