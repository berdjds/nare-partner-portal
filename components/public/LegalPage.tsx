"use client";

/**
 * Shared legal document renderer (W5f, task legal-pages) — app/terms/page.tsx
 * and app/privacy/page.tsx render TERMS_OF_USE and PRIVACY_NOTICE from
 * lib/legal-content.ts through this component, so both pages share one layout:
 * title, subtitle, last-updated date, intro, numbered sections (paragraphs
 * and bullet lists) and a "Contact us" block built from the shared CONTACT
 * and OFFICE_ADDRESS (lib/portal-content.ts) instead of repeating contact
 * details inside the drafted legal text. Token-only colours.
 */

import { LEGAL_LAST_UPDATED, type LegalDocument } from "@/lib/legal-content";
import { primaryEmail, telHref, usePublicContact } from "@/lib/contact/react";

function sectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function LegalPage({ document }: { document: LegalDocument }) {
  const contact = usePublicContact();
  const email = primaryEmail(contact);
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

      <nav aria-label="On this page" aria-labelledby="legal-toc-heading" className="mt-8 space-y-3">
        <p id="legal-toc-heading" className="text-lg font-semibold text-foreground">On this page</p>
        <ul className="list-disc space-y-2 ps-6 text-foreground">
          {document.sections.map((section) => (
            <li key={section.title}>
              <a
                href={`#${sectionId(section.title)}`}
                className="underline-offset-4 hover:underline"
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
          <section key={section.title} className="space-y-3">
            <h2
              id={sectionId(section.title)}
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
          className="space-y-3 rounded-lg border border-border bg-card p-6"
        >
          <h2 id="legal-contact-heading" className="font-display legal-h2 text-foreground">
            Contact us
          </h2>
          {contact.address && <p className="leading-relaxed text-foreground">{contact.address}</p>}
          {email && (
            <p>
              <a
                href={`mailto:${email}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {email}
              </a>
            </p>
          )}
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
        </section>
      </div>
    </article>
  );
}
