"use client";

/**
 * Shared legal document renderer (W5f, task legal-pages) — app/terms/page.tsx
 * and app/privacy/page.tsx render TERMS_OF_USE and PRIVACY_NOTICE from
 * lib/legal-content.ts through this component, so both pages share one layout:
 * title, subtitle, last-updated date, intro, a linked table of contents,
 * numbered sections and a "Contact us" card using usePublicContact().
 * Token-only colours.
 */

import type { MouseEvent } from "react";
import { LEGAL_LAST_UPDATED, type LegalDocument } from "@/lib/legal-content";
import { primaryEmail, telHref, usePublicContact } from "@/lib/contact/react";
import { useT } from "@/lib/i18n/react";

function handleSectionClick(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const heading = window.document.getElementById(id);
  if (!heading) return;

  event.preventDefault();
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
}

export function LegalPage({ document }: { document: LegalDocument }) {
  const contact = usePublicContact();
  const email = primaryEmail(contact);
  const companyName =
    "companyName" in contact && typeof contact.companyName === "string"
      ? contact.companyName
      : undefined;
  const phones = contact.phones ?? [];
  const t = useT();
  const relatedDocument =
    document.title === "Terms of Use"
      ? { title: "Privacy Notice", href: "/privacy" }
      : { title: "Terms of Use", href: "/terms" };

  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <header className="space-y-3 border-b border-border pb-8">
        <h1 className="font-display tracking-tight text-foreground">
          {document.title}
        </h1>
        <p className="text-lg text-muted-foreground">{document.subtitle}</p>
        <p className="text-sm text-muted-foreground">
          Last updated: {LEGAL_LAST_UPDATED}
        </p>
        <p className="leading-relaxed text-foreground">{document.intro}</p>
      </header>

      <nav aria-labelledby="legal-toc-heading" className="mt-8 space-y-3">
        <p id="legal-toc-heading" className="text-lg font-semibold text-foreground">
          {t("legal.toc")}
        </p>
        <ul className="list-disc space-y-2 ps-6 text-foreground">
          {document.sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                onClick={(event) => handleSectionClick(event, section.id)}
                className="break-words rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
        <p>
          <a
            href={relatedDocument.href}
            className="text-primary underline-offset-4 hover:underline"
          >
            Read the {relatedDocument.title}
          </a>
        </p>
      </nav>

      <div className="flex flex-col gap-10 pt-10">
        {document.sections.map((section, index) => (
          <section key={section.id} className="space-y-3">
            <h2
              id={section.id}
              tabIndex={-1}
              className="scroll-mt-24 font-display legal-h2 text-foreground"
            >
              {index + 1}. {section.title}
            </h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph.slice(0, 48)} className="leading-relaxed text-foreground">
                {paragraph}
              </p>
            ))}
            {section.items && (
              <ul className="list-disc space-y-2 ps-6 leading-relaxed text-foreground">
                {section.items.map((item) => (
                  <li key={item.slice(0, 48)}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <section
          aria-labelledby="legal-contact-heading"
          className="space-y-4 rounded-lg border border-border bg-card p-6"
        >
          <h2 id="legal-contact-heading" className="font-display legal-h2 text-foreground">
            {t("legal.contactUs")}
          </h2>
          <dl className="space-y-4">
            {companyName && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">{t("legal.company")}</dt>
                <dd className="mt-1 leading-relaxed text-foreground">{companyName}</dd>
              </div>
            )}
            {email && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">{t("legal.email")}</dt>
                <dd className="mt-1">
                  <a
                    href={`mailto:${email}`}
                    className="break-words text-primary underline-offset-4 hover:underline"
                  >
                    {email}
                  </a>
                </dd>
              </div>
            )}
            {contact.address && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">{t("legal.address")}</dt>
                <dd className="mt-1 leading-relaxed text-foreground">{contact.address}</dd>
              </div>
            )}
            {phones.length > 0 && (
              <div>
                <dt className="text-sm font-medium text-muted-foreground">{t("legal.phones")}</dt>
                <dd className="mt-1 space-y-2">
                  {phones.map((phone) => (
                    <p key={phone.number}>
                      <a
                        href={telHref(phone.number)}
                        className="break-words text-muted-foreground underline-offset-4 hover:text-foreground"
                      >
                        {phone.number}
                      </a>
                    </p>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </section>
      </div>
    </article>
  );
}
