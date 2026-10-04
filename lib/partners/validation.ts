/**
 * Field validation for the public partner application form (W5b).
 *
 * Everything here treats the client as hostile: every text field is bounded
 * and format-checked server-side, optional empty strings are normalised to
 * `undefined`, and both consent checkboxes must be explicitly accepted with
 * the current consent version before an application can be stored. The schema
 * is shared between the public API route and (later) the /partners/apply page
 * so the two can never drift apart.
 *
 * Error messages are written for applicants, not developers — they must never
 * echo internals, and they deliberately say nothing about whether a company
 * or email is already known to us.
 */

import { z } from "zod";

/** Version stamped on every application so the exact consent wording shown is on record. */
export const CONSENT_VERSION = "2026-10-v1";

const PHONE_PATTERN = /^\+?\d{8,15}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Trims and maps empty/whitespace-only optional strings to undefined. */
function optionalString<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    schema.optional(),
  );
}

function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s()-]/g, ""))
  .refine((value) => PHONE_PATTERN.test(value), {
    message: "Enter a phone number with 8 to 15 digits (country code included)",
  });

export const applicationFieldsSchema = z.object({
  companyLegalName: z.string().trim().min(2, "Enter the registered company name").max(200),
  tradingName: optionalString(z.string().trim().max(200)),
  country: z.string().trim().min(2, "Enter the country").max(100),
  city: z.string().trim().min(1, "Enter the city").max(100),
  address: z.string().trim().min(3, "Enter the registered address").max(500),
  website: optionalString(
    z.string().trim().max(300).url("Enter a full website address, e.g. https://example.com"),
  ),
  licenceNumber: z.string().trim().min(1, "Enter the trade licence number").max(100),
  licenceAuthority: z.string().trim().min(1, "Enter the issuing authority").max(150),
  licenceExpiry: z
    .string()
    .trim()
    .refine(isValidCalendarDate, { message: "Enter the licence expiry date as YYYY-MM-DD" }),
  contactName: z.string().trim().min(2, "Enter the contact person's name").max(150),
  contactRole: optionalString(z.string().trim().max(150)),
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .email("Enter a valid email address")
    .transform((value) => value.toLowerCase()),
  contactPhone: phoneSchema,
  secondContactName: optionalString(z.string().trim().max(150)),
  secondContactEmail: optionalString(
    z
      .string()
      .trim()
      .max(254)
      .email("Enter a valid email address")
      .transform((value) => value.toLowerCase()),
  ),
  secondContactPhone: optionalString(phoneSchema),
  notes: optionalString(z.string().trim().max(2000)),
  // Submitted as the string "true" by the form, stored as a Boolean.
  consentKyc: z
    .literal("true", {
      errorMap: () => ({ message: "Consent to KYC document processing is required" }),
    })
    .transform(() => true as const),
  consentChannels: z
    .literal("true", {
      errorMap: () => ({ message: "Consent to being contacted by email and WhatsApp is required" }),
    })
    .transform(() => true as const),
  consentVersion: z.literal(CONSENT_VERSION, {
    errorMap: () => ({ message: "The consent text has changed — please reload the form and review it again" }),
  }),
});

export type ApplicationFields = z.infer<typeof applicationFieldsSchema>;

/** The text-field names the route reads out of the multipart form. */
export const APPLICATION_FIELD_NAMES = Object.keys(applicationFieldsSchema.shape);

/**
 * Pulls the known text fields out of a multipart FormData into a plain object
 * for the schema. File parts and unknown fields (honeypot, form token) are
 * handled separately by the route / abuse module and are ignored here.
 */
export function collectApplicationFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of APPLICATION_FIELD_NAMES) {
    const value = form.get(name);
    if (typeof value === "string") fields[name] = value;
  }
  return fields;
}
