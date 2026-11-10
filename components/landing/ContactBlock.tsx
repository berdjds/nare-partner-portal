"use client";

import { MAILTO_SUBJECTS } from "@/lib/portal-content";
import { primaryEmail, telHref, usePublicContact } from "@/lib/contact/react";

export function ContactBlock() {
  const contact = usePublicContact();
  const email = primaryEmail(contact);
  return (
    <section className="bg-muted">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-24">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Contact
        </h2>
        <div className="mt-8 space-y-4 text-base">
          {email && (
            <p>
              <a
                href={`mailto:${email}?subject=${encodeURIComponent(
                  MAILTO_SUBJECTS.contact,
                )}`}
                className="font-medium text-primary hover:underline"
              >
                {email}
              </a>
            </p>
          )}
          {contact.phones && contact.phones.length > 0 && (
            <p className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-6">
              {contact.phones.map((phone) => (
                <a
                  key={phone.number}
                  href={telHref(phone.number)}
                  className="font-medium text-primary hover:underline"
                >
                  {phone.number}
                </a>
              ))}
            </p>
          )}
        </div>
        {contact.mapEmbedUrl && (
          <iframe
            title="Map"
            src={contact.mapEmbedUrl}
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin"
            className="mx-auto mt-8 h-64 w-full max-w-2xl rounded-lg border border-border"
          />
        )}
      </div>
    </section>
  );
}
