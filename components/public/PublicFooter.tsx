/**
 * Shared public site footer (W5f, task pub-chrome) — legal links (Terms,
 * Privacy), the contact email and phones from CONTACT, the office address
 * from OFFICE_ADDRESS and the copyright line with developer attribution.
 * Token-only colours; no
 * client-side interactivity, so it can render from server and client pages.
 */

"use client";

import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/portal-content";
import { telHref, usePublicContact } from "@/lib/contact/react";
import { useT } from "@/lib/i18n/react";

export function PublicFooter() {
  const year = new Date().getFullYear();
  const contact = usePublicContact();
  const t = useT();

  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-10 sm:flex-row sm:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">{PRODUCT_NAME}</p>
          {contact.address && (
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              {contact.address}
            </p>
          )}
          {contact.foundedYear && (
            <p className="text-sm text-muted-foreground">{t("footer.since", { year: contact.foundedYear })}</p>
          )}
        </div>

        <div className="space-y-2 text-sm">
          {[contact.b2bEmail, contact.generalEmail].filter((e, i, a): e is string => Boolean(e) && a.indexOf(e) === i).map((email) => (
            <p key={email}>
              <a
                href={`mailto:${email}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {email}
              </a>
            </p>
          ))}
          {(contact.phones ?? []).map((phone) => (
            <p key={phone.number}>
              <a
                href={telHref(phone.number)}
                className="text-muted-foreground underline-offset-4 hover:text-foreground"
              >
                {phone.number}
              </a>
            </p>
          ))}
          {contact.hours && <p className="text-muted-foreground">{contact.hours}</p>}
        </div>

        <nav aria-label={t("footer.legalNav")} className="flex flex-col gap-2 text-sm">
          <Link
            href="/terms"
            className="text-muted-foreground underline-offset-4 hover:text-foreground"
          >
            {t("footer.terms")}
          </Link>
          <Link
            href="/privacy"
            className="text-muted-foreground underline-offset-4 hover:text-foreground"
          >
            {t("footer.privacy")}
          </Link>
        </nav>
      </div>

      <div className="border-t border-border">
        <p className="mx-auto max-w-5xl px-6 py-4 text-[13px] text-muted-foreground">
          {t("footer.rights", { year, name: PRODUCT_NAME })}
        </p>
      </div>
    </footer>
  );
}
