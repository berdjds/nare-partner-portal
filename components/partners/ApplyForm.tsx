"use client";

/**
 * Public partner application form (W5b) — rendered by app/partners/apply/page.tsx.
 *
 * The field names mirror applicationFieldsSchema (lib/partners/validation.ts)
 * exactly, because the form posts multipart FormData straight to
 * POST /api/partners/applications. Abuse tripwires come along as inert
 * inputs: the signed form token (minted by the page), the consent version,
 * and the honeypot field `companyFax` — the literal name is repeated here
 * because lib/partners/abuse.ts is a node-only module (node:crypto) and
 * cannot be imported from a client component; tests assert they match.
 *
 * Error contract of the endpoint: `{ reference }` on success, otherwise
 * either `{ error: <ZodIssue[]> }` (mapped onto the matching fields) or
 * `{ error: <generic string> }` (shown once, with role="alert"). The generic
 * messages deliberately say nothing about which check failed.
 *
 * Client-side file checks (extension + 10 MB) only save a round trip — the
 * server re-checks by magic bytes. The size limit mirrors
 * KYC_MAX_FILE_BYTES in lib/partners/kyc-storage.ts, which is a node-only
 * module (node:fs) and cannot be imported here either.
 */

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CONTACT, PARTNER_APPLY } from "@/lib/portal-content";
import { CONSENT_VERSION } from "@/lib/partners/validation";

// Mirrors KYC_MAX_FILE_BYTES (lib/partners/kyc-storage.ts, node-only).
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_FILE_EXTENSIONS = [".pdf", ".jpg", ".jpeg", ".png"];
const FILE_INPUT_ACCEPT = ALLOWED_FILE_EXTENSIONS.join(",");

// Mirrors HONEYPOT_FIELD (lib/partners/abuse.ts, node-only).
const HONEYPOT_FIELD_NAME = "companyFax";

const FILE_FIELD_NAMES = ["licenceFile", "signatoryIdFile", "otherFile"] as const;

const GENERIC_SUBMIT_ERROR =
  "Your application could not be submitted. Please check the form and try again.";
const NETWORK_ERROR =
  "The application could not be sent. Please check your connection and try again.";

/** Client-side pre-check; the server decides the real type by magic bytes. */
function validateUpload(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return "Files must be at most 10 MB each.";
  }
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!ALLOWED_FILE_EXTENSIONS.includes(extension)) {
    return "Files must be PDF, JPG or PNG.";
  }
  return null;
}

function isPresentFile(value: FormDataEntryValue | null): value is File {
  return typeof File !== "undefined" && value instanceof File && (value.size > 0 || value.name !== "");
}

export function ApplySuccess({ reference }: { reference: string }) {
  return (
    <div role="status" className="rounded-lg border border-border bg-card p-8">
      <h2 className="text-2xl font-semibold tracking-tight">{PARTNER_APPLY.successTitle}</h2>
      <p className="mt-6 text-sm text-muted-foreground">{PARTNER_APPLY.successReferenceLabel}</p>
      <p className="mt-1 font-mono text-xl font-semibold">{reference}</p>
      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{PARTNER_APPLY.successBody}</p>
      <p className="mt-6 text-sm">
        <a
          href={`mailto:${CONTACT.email}`}
          className="text-primary underline underline-offset-4"
        >
          {CONTACT.email}
        </a>
        {" · "}
        <Link href="/" className="text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Back to home
        </Link>
      </p>
    </div>
  );
}

export function ApplyForm({ formToken }: { formToken: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);

  function errorId(name: string): string {
    return `${name}-error`;
  }

  function fieldError(name: string) {
    const message = fieldErrors[name];
    if (!message) return null;
    return (
      <p id={errorId(name)} className="text-sm font-medium text-destructive">
        {message}
      </p>
    );
  }

  function validityProps(name: string) {
    return {
      "aria-invalid": fieldErrors[name] ? true : undefined,
      "aria-describedby": fieldErrors[name] ? errorId(name) : undefined,
    };
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const data = new FormData(event.currentTarget);

    // Client-side file checks only spare a round trip; the server re-checks.
    const uploadErrors: Record<string, string> = {};
    for (const name of FILE_FIELD_NAMES) {
      const value = data.get(name);
      if (isPresentFile(value)) {
        const problem = validateUpload(value);
        if (problem) uploadErrors[name] = problem;
      }
    }
    if (Object.keys(uploadErrors).length > 0) {
      setFieldErrors(uploadErrors);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/partners/applications", { method: "POST", body: data });
      const body = await response.json().catch(() => null);

      if (response.ok && body && typeof body.reference === "string") {
        setReference(body.reference);
        return;
      }

      if (body && Array.isArray(body.error)) {
        const next: Record<string, string> = {};
        for (const issue of body.error) {
          const key = Array.isArray(issue?.path) ? String(issue.path[0] ?? "") : "";
          if (key && !(key in next)) next[key] = String(issue?.message ?? "Invalid value");
        }
        setFieldErrors(next);
        if (Object.keys(next).length === 0) setFormError(GENERIC_SUBMIT_ERROR);
        return;
      }

      setFormError(body && typeof body.error === "string" ? body.error : GENERIC_SUBMIT_ERROR);
    } catch {
      setFormError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  if (reference !== null) {
    return <ApplySuccess reference={reference} />;
  }

  const inputClass = "h-11";

  return (
    <form onSubmit={handleSubmit} encType="multipart/form-data" aria-busy={submitting} className="space-y-10">
      {/* Abuse tripwires: signed token + consent version travel as hidden
          inputs; the honeypot is invisible to humans and skipped by keyboard. */}
      <input type="hidden" name="formToken" value={formToken} />
      <input type="hidden" name="consentVersion" value={CONSENT_VERSION} />
      <div className="hidden" aria-hidden="true">
        <Label htmlFor={HONEYPOT_FIELD_NAME}>Company fax</Label>
        <Input id={HONEYPOT_FIELD_NAME} name={HONEYPOT_FIELD_NAME} type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.company}</legend>
        <div className="space-y-2">
          <Label htmlFor="companyLegalName">{PARTNER_APPLY.labels.companyLegalName}</Label>
          <Input id="companyLegalName" name="companyLegalName" required maxLength={200} className={inputClass} {...validityProps("companyLegalName")} />
          {fieldError("companyLegalName")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="tradingName">{PARTNER_APPLY.labels.tradingName}</Label>
          <Input id="tradingName" name="tradingName" maxLength={200} className={inputClass} {...validityProps("tradingName")} />
          {fieldError("tradingName")}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="country">{PARTNER_APPLY.labels.country}</Label>
            <Input id="country" name="country" required maxLength={100} autoComplete="country-name" className={inputClass} {...validityProps("country")} />
            {fieldError("country")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">{PARTNER_APPLY.labels.city}</Label>
            <Input id="city" name="city" required maxLength={100} autoComplete="address-level2" className={inputClass} {...validityProps("city")} />
            {fieldError("city")}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="address">{PARTNER_APPLY.labels.address}</Label>
          <Textarea id="address" name="address" required maxLength={500} rows={2} {...validityProps("address")} />
          {fieldError("address")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="website">{PARTNER_APPLY.labels.website}</Label>
          <Input id="website" name="website" type="url" maxLength={300} placeholder="https://example.com" className={inputClass} {...validityProps("website")} />
          {fieldError("website")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="notes">{PARTNER_APPLY.labels.notes}</Label>
          <Textarea id="notes" name="notes" maxLength={2000} rows={3} {...validityProps("notes")} />
          {fieldError("notes")}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.licence}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="licenceNumber">{PARTNER_APPLY.labels.licenceNumber}</Label>
            <Input id="licenceNumber" name="licenceNumber" required maxLength={100} className={inputClass} {...validityProps("licenceNumber")} />
            {fieldError("licenceNumber")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="licenceAuthority">{PARTNER_APPLY.labels.licenceAuthority}</Label>
            <Input id="licenceAuthority" name="licenceAuthority" required maxLength={150} className={inputClass} {...validityProps("licenceAuthority")} />
            {fieldError("licenceAuthority")}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="licenceExpiry">{PARTNER_APPLY.labels.licenceExpiry}</Label>
          <Input id="licenceExpiry" name="licenceExpiry" type="date" required className={inputClass} {...validityProps("licenceExpiry")} />
          {fieldError("licenceExpiry")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="licenceFile">{PARTNER_APPLY.labels.licenceFile}</Label>
          <Input id="licenceFile" name="licenceFile" type="file" required accept={FILE_INPUT_ACCEPT} className="h-11 py-2" {...validityProps("licenceFile")} />
          <p className="text-sm text-muted-foreground">{PARTNER_APPLY.fileRules}</p>
          {fieldError("licenceFile")}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.contacts}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contactName">{PARTNER_APPLY.labels.contactName}</Label>
            <Input id="contactName" name="contactName" required maxLength={150} autoComplete="name" className={inputClass} {...validityProps("contactName")} />
            {fieldError("contactName")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactRole">{PARTNER_APPLY.labels.contactRole}</Label>
            <Input id="contactRole" name="contactRole" maxLength={150} autoComplete="organization-title" className={inputClass} {...validityProps("contactRole")} />
            {fieldError("contactRole")}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="contactEmail">{PARTNER_APPLY.labels.contactEmail}</Label>
            <Input id="contactEmail" name="contactEmail" type="email" required maxLength={254} autoComplete="email" className={inputClass} {...validityProps("contactEmail")} />
            {fieldError("contactEmail")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="contactPhone">{PARTNER_APPLY.labels.contactPhone}</Label>
            <Input id="contactPhone" name="contactPhone" type="tel" required autoComplete="tel" placeholder="+374 91 000000" className={inputClass} {...validityProps("contactPhone")} />
            <p className="text-sm text-muted-foreground">{PARTNER_APPLY.contactPhoneHelper}</p>
            {fieldError("contactPhone")}
          </div>
        </div>

        <p className="pt-2 text-sm font-medium text-muted-foreground">{PARTNER_APPLY.labels.secondContact}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="secondContactName">{PARTNER_APPLY.labels.secondContactName}</Label>
            <Input id="secondContactName" name="secondContactName" maxLength={150} className={inputClass} {...validityProps("secondContactName")} />
            {fieldError("secondContactName")}
          </div>
          <div className="space-y-2">
            <Label htmlFor="secondContactEmail">{PARTNER_APPLY.labels.secondContactEmail}</Label>
            <Input id="secondContactEmail" name="secondContactEmail" type="email" maxLength={254} className={inputClass} {...validityProps("secondContactEmail")} />
            {fieldError("secondContactEmail")}
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="secondContactPhone">{PARTNER_APPLY.labels.secondContactPhone}</Label>
          <Input id="secondContactPhone" name="secondContactPhone" type="tel" className={inputClass} {...validityProps("secondContactPhone")} />
          {fieldError("secondContactPhone")}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.signatory}</legend>
        <div className="space-y-2">
          <Label htmlFor="signatoryIdFile">{PARTNER_APPLY.labels.signatoryIdFile}</Label>
          <Input id="signatoryIdFile" name="signatoryIdFile" type="file" accept={FILE_INPUT_ACCEPT} className="h-11 py-2" {...validityProps("signatoryIdFile")} />
          <p className="text-sm text-muted-foreground">{PARTNER_APPLY.fileRules}</p>
          {fieldError("signatoryIdFile")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="otherFile">{PARTNER_APPLY.labels.otherFile}</Label>
          <Input id="otherFile" name="otherFile" type="file" accept={FILE_INPUT_ACCEPT} className="h-11 py-2" {...validityProps("otherFile")} />
          <p className="text-sm text-muted-foreground">{PARTNER_APPLY.fileRules}</p>
          {fieldError("otherFile")}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.consent}</legend>
        {(["consentKyc", "consentChannels"] as const).map((name) => (
          <div key={name} className="space-y-2">
            <div className="flex items-start gap-3">
              <input
                id={name}
                name={name}
                type="checkbox"
                value="true"
                required
                className="mt-0.5 h-5 w-5 shrink-0 rounded border border-input accent-primary"
                {...validityProps(name)}
              />
              <Label htmlFor={name} className="text-sm font-normal leading-relaxed">
                {PARTNER_APPLY.labels[name]}
              </Label>
            </div>
            {fieldError(name)}
          </div>
        ))}
      </fieldset>

      {formError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {formError}
        </p>
      )}

      <Button type="submit" disabled={submitting} className="h-12 w-full px-8 text-base font-semibold sm:w-auto">
        {submitting ? PARTNER_APPLY.submittingLabel : PARTNER_APPLY.submitLabel}
      </Button>
    </form>
  );
}
