"use client";

import Link from "next/link";
import { ArrowRight, Mail, MapPin, Phone } from "lucide-react";
import { MAILTO_SUBJECTS } from "@/lib/portal-content";
import { useT } from "@/lib/i18n/react";
import { primaryEmail, telHref, usePublicContact } from "@/lib/contact/react";

/** Closing call to action plus the contact details, all from the admin-managed contact settings. */
export function ContactBlock() {
  const contact = usePublicContact();
  const t = useT();
  const email = primaryEmail(contact);
  return (
    <section id="contact" aria-labelledby="contact-heading" className="bg-background">
      <div className="mx-auto max-w-7xl px-6 pb-14 lg:pb-20">
        <div className="relative overflow-hidden rounded-[28px] bg-plum text-white shadow-[var(--shadow-lift)]">
          <div aria-hidden="true" className="absolute inset-0 bg-cover bg-center opacity-25" style={{ backgroundImage: 'url("/brand/photos/about-monastery.webp")' }} />
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-r from-plum via-plum/90 to-plum/60" />
          <div className="relative grid gap-10 p-8 sm:p-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
            <div>
              <p className="font-display text-3xl leading-tight sm:text-4xl">{t("cta.title")}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/login" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white px-7 text-base font-semibold text-plum transition hover:bg-white/90">
                  {t("common.signIn")}
                  <ArrowRight className="h-4 w-4 rtl:rotate-180" aria-hidden="true" />
                </Link>
                <Link href="/partners/apply" className="inline-flex h-12 items-center justify-center rounded-xl border-2 border-white/50 px-7 text-base font-semibold text-white transition hover:bg-white/10">
                  {t("nav.apply")}
                </Link>
              </div>
            </div>
            <div>
              <h2 id="contact-heading" className="text-sm font-semibold uppercase tracking-[0.16em] text-warm">{t("landing.title.contact")}</h2>
              <ul className="mt-5 space-y-4 text-lg">
                {email && (
                  <li className="flex items-center gap-3"><Mail className="h-5 w-5 shrink-0 text-warm" aria-hidden="true" />
                    <a href={`mailto:${email}?subject=${encodeURIComponent(MAILTO_SUBJECTS.contact)}`} className="font-medium underline-offset-4 hover:underline">{email}</a></li>
                )}
                {contact.phones?.map((phone) => (
                  <li key={phone.number} className="flex items-center gap-3"><Phone className="h-5 w-5 shrink-0 text-warm" aria-hidden="true" />
                    <a href={telHref(phone.number)} className="font-medium underline-offset-4 hover:underline">{phone.number}</a></li>
                ))}
                {contact.address && (
                  <li className="flex items-start gap-3 text-base text-white/85"><MapPin className="mt-0.5 h-5 w-5 shrink-0 text-warm" aria-hidden="true" />
                    {contact.mapLinkUrl ? <a href={contact.mapLinkUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">{contact.address}</a> : <span>{contact.address}</span>}</li>
                )}
              </ul>
              {contact.mapEmbedUrl && (
                <iframe title="Map" src={contact.mapEmbedUrl} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" className="mt-6 h-44 w-full rounded-2xl border border-white/20" />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
