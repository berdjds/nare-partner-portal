import { CONTACT, MAILTO_SUBJECTS } from "@/lib/portal-content";

export function ContactBlock() {
  return (
    <section className="bg-muted">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center sm:py-24">
        <h2 className="text-3xl font-semibold tracking-tight text-foreground">
          Contact
        </h2>
        <div className="mt-8 space-y-4 text-base">
          <p>
            <a
              href={`mailto:${CONTACT.email}?subject=${encodeURIComponent(
                MAILTO_SUBJECTS.contact,
              )}`}
              className="font-medium text-primary hover:underline"
            >
              {CONTACT.email}
            </a>
          </p>
          <p className="flex flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-6">
            {CONTACT.phones.map((phone) => (
              <a
                key={phone}
                href={`tel:${phone.replace(/\s/g, "")}`}
                className="font-medium text-primary hover:underline"
              >
                {phone}
              </a>
            ))}
          </p>
        </div>
      </div>
    </section>
  );
}
