/**
 * Shared public site footer. Visual system adapted from staging.nare.am (components/footer.tsx): charcoal footer,
 * four columns, outlined circular social buttons, round contact icon chips, legal bar. The content is portal-appropriate and
 * every contact fact and social link comes from the admin-managed contact settings (nothing is hard-coded here).
 * The brand lockup lives in the header only, so the footer shows the name as plain text.
 */

"use client";

import type { ComponentType, SVGProps } from "react";
import Link from "next/link";
import { Facebook, Instagram, Linkedin, Mail, MapPin, Phone, Twitter, Youtube } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/portal-content";
import { telHref, usePublicContact } from "@/lib/contact/react";
import { useT } from "@/lib/i18n/react";
import type { SocialPlatform } from "@/lib/contact/schema";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;
const TikTok: Icon = (props) => (<svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path fill="currentColor" d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" /></svg>);
const Tripadvisor: Icon = (props) => (<svg viewBox="0 0 24 24" aria-hidden="true" {...props}><path fill="currentColor" d="M12.006 4.295c-2.67 0-5.338.784-7.645 2.353H0l1.963 2.135a5.997 5.997 0 0 0 4.04 10.43 5.976 5.976 0 0 0 4.075-1.6L12 19.705l1.922-2.09a5.972 5.972 0 0 0 4.072 1.598 6 6 0 0 0 6-5.998 5.982 5.982 0 0 0-1.957-4.432L24 6.648h-4.35a13.573 13.573 0 0 0-7.644-2.353zM12 6.255c1.531 0 3.063.303 4.504.903C13.943 8.138 12 10.43 12 13.1c0-2.671-1.942-4.962-4.504-5.942A11.72 11.72 0 0 1 12 6.256zM6.002 9.157a4.059 4.059 0 1 1 0 8.118 4.059 4.059 0 0 1 0-8.118zm11.992.002a4.057 4.057 0 1 1 .003 8.115 4.057 4.057 0 0 1-.003-8.115zm-11.992 1.93a2.128 2.128 0 0 0 0 4.256 2.128 2.128 0 0 0 0-4.256zm11.992 0a2.128 2.128 0 0 0 0 4.256 2.128 2.128 0 0 0 0-4.256z" /></svg>);

const SOCIAL: Record<SocialPlatform, { Icon: Icon; label: string }> = {
  facebook: { Icon: Facebook as Icon, label: "Facebook" },
  instagram: { Icon: Instagram as Icon, label: "Instagram" },
  linkedin: { Icon: Linkedin as Icon, label: "LinkedIn" },
  tiktok: { Icon: TikTok, label: "TikTok" },
  youtube: { Icon: Youtube as Icon, label: "YouTube" },
  twitter: { Icon: Twitter as Icon, label: "X" },
  tripadvisor: { Icon: Tripadvisor, label: "TripAdvisor" },
};
const ORDER: SocialPlatform[] = ["facebook", "instagram", "linkedin", "tiktok", "youtube", "twitter", "tripadvisor"];

const link = "text-white/70 underline-offset-4 transition-colors hover:text-white hover:underline";

/** `compact` is the slim bar used on the sign-in and application pages: no repeated contact block, just legal links and social icons. */
export function PublicFooter({ compact = false }: { compact?: boolean } = {}) {
  const year = new Date().getFullYear();
  const contact = usePublicContact();
  const t = useT();
  const emails = [contact.b2bEmail, contact.generalEmail].filter((e, i, a): e is string => Boolean(e) && a.indexOf(e) === i);
  const socials = ORDER.filter((p) => contact.social?.[p]);

  if (compact) {
    return (
      <footer className="bg-footer text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-white/60">{t("footer.rights", { year, name: PRODUCT_NAME })}</p>
          <nav aria-label={t("footer.legalNav")} className="flex items-center gap-5 text-sm">
            <Link href="/terms" className={link}>{t("footer.terms")}</Link>
            <Link href="/privacy" className={link}>{t("footer.privacy")}</Link>
          </nav>
        </div>
      </footer>
    );
  }

  return (
    <footer className="relative overflow-hidden bg-footer text-white">
      <div aria-hidden="true" className="pointer-events-none absolute -top-40 -end-24 h-[26rem] w-[26rem] rounded-full bg-primary/20 blur-[120px]" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-48 -start-24 h-[30rem] w-[30rem] rounded-full bg-brand/20 blur-[120px]" />
      <div className="relative mx-auto max-w-7xl px-6 py-14 lg:py-16">
        <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-[1.4fr_0.8fr_0.8fr_1.4fr]">
          <div className="space-y-5">
            <p className="font-display text-3xl">{PRODUCT_NAME}</p>
            <p className="max-w-sm leading-relaxed text-white/70">{t("footer.description")}</p>
            {contact.foundedYear && <p className="text-sm text-white/60">{t("footer.since", { year: contact.foundedYear })}</p>}
            {socials.length > 0 && (
              <div>
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-white/50">{t("footer.follow")}</p>
                <ul className="flex flex-wrap gap-2.5">
                  {socials.map((p) => {
                    const { Icon, label } = SOCIAL[p];
                    return (
                      <li key={p}>
                        <a href={contact.social![p]} target="_blank" rel="noopener noreferrer" aria-label={t("footer.social", { name: label })} className="grid h-11 w-11 place-items-center rounded-full border border-white/25 text-white/80 transition hover:-translate-y-0.5 hover:border-white hover:bg-white hover:text-footer">
                          <Icon className="h-5 w-5" />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <nav aria-label={t("footer.portal")}>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-white/50">{t("footer.portal")}</p>
            <ul className="space-y-3">
              <li><Link href="/" className={link}>{t("nav.home")}</Link></li>
              <li><Link href="/login" className={link}>{t("common.signIn")}</Link></li>
              <li><Link href="/partners/apply" className={link}>{t("nav.apply")}</Link></li>
            </ul>
          </nav>

          <nav aria-label={t("footer.legalNav")}>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-white/50">{t("footer.legalNav")}</p>
            <ul className="space-y-3">
              <li><Link href="/terms" className={link}>{t("footer.terms")}</Link></li>
              <li><Link href="/privacy" className={link}>{t("footer.privacy")}</Link></li>
            </ul>
          </nav>

          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-white/50">{t("footer.contact")}</p>
            <ul className="space-y-4">
              {emails.map((email) => (
                <li key={email} className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-warm"><Mail className="h-4 w-4" aria-hidden="true" /></span>
                  <a href={`mailto:${email}`} className={link}>{email}</a>
                </li>
              ))}
              {(contact.phones ?? []).map((phone) => (
                <li key={phone.number} className="flex items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-warm"><Phone className="h-4 w-4" aria-hidden="true" /></span>
                  <a href={telHref(phone.number)} className={link}>{phone.number}</a>
                </li>
              ))}
              {contact.address && (
                <li className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/10 text-warm"><MapPin className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="pt-1.5 text-white/70">
                    {contact.address}
                    {contact.mapLinkUrl && <> · <a href={contact.mapLinkUrl} target="_blank" rel="noopener noreferrer" className="text-white underline underline-offset-4">{t("footer.map")}</a></>}
                  </span>
                </li>
              )}
              {contact.hours && <li className="ps-12 text-sm text-white/60">{contact.hours}</li>}
            </ul>
          </div>
        </div>

        <p className="mt-12 border-t border-white/10 pt-6 text-sm text-white/55">{t("footer.rights", { year, name: PRODUCT_NAME })}</p>
      </div>
    </footer>
  );
}
