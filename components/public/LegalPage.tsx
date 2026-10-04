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
import { CONTACT, OFFICE_ADDRESS } from "@/lib/portal-content";

export function LegalPage({ document }: { document: LegalDocument }) {
  return (
    <article className="mx-auto max-w-3xl px-6 py-12">
      <header className="space-y-3 border-b border-border pb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {document.title}
        </h1>
        <p className="text-lg text-muted-foreground">{document.subtitle}</p>
        <p className="text-sm text-muted-foreground">
          Last updated: {LEGAL_LAST_UPDATED}
        </p>
        <p className="leading-relaxed text-foreground">{document.intro}</p>
      </header>

      <div className="flex flex-col gap-10 pt-10">
        {document.sections.map((section, index) => (
          <section key={section.title} className="space-y-3">
            <h2 className="text-xl font-semibold text-foreground">
              {index + 1}. {section.title}
            </h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph.slice(0, 48)} className="leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
            {section.items && (
              <ul className="list-disc space-y-2 pl-6 leading-relaxed text-muted-foreground">
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
          <h2 id="legal-contact-heading" className="text-xl font-semibold text-foreground">
            Contact us
          </h2>
          <p className="leading-relaxed text-muted-foreground">{OFFICE_ADDRESS}</p>
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
        </section>
      </div>
    </article>
  );
}
