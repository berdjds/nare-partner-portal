"use client";

import Link from "next/link";
import { ArrowRight, Mail, Phone } from "lucide-react";
import { MAILTO_SUBJECTS } from "@/lib/portal-content";
import { useT } from "@/lib/i18n/react";
import { primaryEmail, telHref, usePublicContact } from "@/lib/contact/react";

export function ContactBlock() {
  const contact = usePublicContact();
  const t = useT();
  const email = primaryEmail(contact);
  const hasMap = Boolean(contact.mapEmbedUrl);
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-12 sm:py-16">
        <div className={`grid gap-8 overflow-hidden rounded-[28px] bg-plum p-8 text-white shadow-[var(--shadow-lift)] sm:p-12 lg:grid-cols-[1fr_1.1fr]`}>
          <div>
            <h2 className="font-display text-3xl leading-tight sm:text-4xl">{t("landing.title.contact")}</h2>
            <span aria-hidden="true" className="mt-4 block h-1 w-14 rounded-full bg-warm" />
            <div className="mt-8 space-y-4 text-lg">
              {email && (
                <p className="flex items-center gap-3">
                  <Mail className="h-5 w-5 shrink-0 text-warm" aria-hidden="true" />
                  <a href={`mailto:${email}?subject=${encodeURIComponent(MAILTO_SUBJECTS.contact)}`} className="font-medium underline-offset-4 hover:underline">{email}</a>
                </p>
              )}
              {contact.phones?.map((phone) => (
                <p key={phone.number} className="flex items-center gap-3">
                  <Phone className="h-5 w-5 shrink-0 text-warm" aria-hidden="true" />
                  <a href={telHref(phone.number)} className="font-medium underline-offset-4 hover:underline">{phone.number}</a>
                </p>
              ))}
            </div>
          </div>
          {!hasMap && (
            <div className="flex flex-col justify-center gap-4 rounded-2xl border border-white/15 bg-white/5 p-6 sm:p-8">
              <p className="font-display text-2xl leading-snug">{t("landing.headline")}</p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <Link href="/login" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-6 text-sm font-semibold text-plum transition hover:bg-white/90">
                  {t("common.signIn")}
                  <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
                </Link>
                <Link href="/partners/apply" className="inline-flex h-11 items-center justify-center rounded-xl border border-white/40 px-6 text-sm font-semibold text-white transition hover:bg-white/10">
                  {t("nav.apply")}
                </Link>
              </div>
            </div>
          )}
          {hasMap && (
            <iframe
              title="Map"
              src={contact.mapEmbedUrl}
              loading="lazy"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin"
              className="h-64 w-full rounded-2xl border border-white/20 lg:h-full lg:min-h-64"
            />
          )}
        </div>
      </div>
    </section>
  );
}
