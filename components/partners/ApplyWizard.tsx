"use client";

/**
 * Staged public partner application form (W5f).
 *
 * Same endpoint and field contract as the single-page ApplyForm (W5b), split
 * into four stages — company, trade licence, contacts, review — so applicants
 * see one small set of questions at a time. All four stage sections stay
 * mounted (inactive ones are `hidden`): hidden inputs still submit with the
 * FormData, so the controlled `values` state and the DOM never drift apart.
 * Files are the exception — a file input cannot be repopulated with a chosen
 * File, so the File objects live in component state (the single source of
 * truth for files) and are appended to the FormData at submit time.
 *
 * The form uses noValidate because every stage holds required fields that are
 * hidden at any given moment; native constraint validation would block the
 * submit on fields the applicant cannot see. Per-stage checks reuse the
 * shared applicationFieldsSchema messages instead (validateStage).
 *
 * Only client-safe modules are imported here (portal content, the zod schema,
 * location data, legal titles, the shared pieces re-exported by ApplyForm);
 * node-only modules (abuse, kyc-storage, prisma) must stay out of the client
 * bundle. Nothing is persisted to localStorage/sessionStorage and no personal
 * data goes into the URL.
 */

import { useEffect, useRef, useState } from "react";
import type { ZodTypeAny } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PARTNER_APPLY } from "@/lib/portal-content";
import { applicationFieldsSchema, CONSENT_VERSION } from "@/lib/partners/validation";
import { COUNTRIES, getCitySuggestions } from "@/lib/partners/locations";
import { TERMS_OF_USE, PRIVACY_NOTICE } from "@/lib/legal-content";
import {
  ApplySuccess,
  FILE_FIELD_NAMES,
  FILE_INPUT_ACCEPT,
  GENERIC_SUBMIT_ERROR,
  HONEYPOT_FIELD_NAME,
  NETWORK_ERROR,
  isPresentFile,
  validateUpload,
  type FileFieldName,
} from "./ApplyForm";

export type StageKey = "company" | "licence" | "contacts" | "review";

export const STAGES: readonly { key: StageKey; fields: readonly string[] }[] = [
  {
    key: "company",
    fields: ["companyLegalName", "tradingName", "country", "city", "address", "website", "notes"],
  },
  {
    key: "licence",
    fields: ["licenceNumber", "licenceAuthority", "licenceExpiry"],
  },
  {
    key: "contacts",
    fields: [
      "contactName",
      "contactRole",
      "contactEmail",
      "contactPhone",
      "secondContactName",
      "secondContactEmail",
      "secondContactPhone",
    ],
  },
  { key: "review", fields: [] },
];

/** Human-readable upload size for the file summary rows. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fieldSchemas = applicationFieldsSchema.shape as Record<string, ZodTypeAny>;

/**
 * Per-stage validation with the shared schema messages. Pure (no DOM, no
 * window) so unit tests can run it in node. Returns field name → message.
 */
export function validateStage(
  stage: StageKey,
  values: Record<string, string>,
  files: Record<FileFieldName, File | null>,
): Record<string, string> {
  const errors: Record<string, string> = {};

  const fields =
    stage === "review"
      ? ["consentKyc", "consentChannels"]
      : (STAGES.find((s) => s.key === stage)?.fields ?? []);

  for (const field of fields) {
    const result = fieldSchemas[field].safeParse(values[field] ?? "");
    if (!result.success) {
      errors[field] = result.error.issues[0]?.message ?? "Invalid value";
    }
  }

  if (stage === "licence") {
    if (files.licenceFile === null) {
      errors.licenceFile = PARTNER_APPLY.licenceFileRequired;
    }
    for (const name of FILE_FIELD_NAMES) {
      const file = files[name];
      if (file !== null) {
        const problem = validateUpload(file);
        if (problem) errors[name] = problem;
      }
    }
  }

  return errors;
}

/** labels is a typed content object; the wizard indexes it by field name. */
const FIELD_LABELS: Record<string, string> = { ...PARTNER_APPLY.labels };

const CONSENT_FIELD_NAMES = ["consentKyc", "consentChannels"] as const;

function stepText(index: number): string {
  return PARTNER_APPLY.stepLabel
    .replace("{step}", String(index + 1))
    .replace("{total}", String(STAGES.length));
}

export function ApplyWizard({ formToken }: { formToken: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const stage of STAGES) {
      for (const field of stage.fields) initial[field] = "";
    }
    for (const name of CONSENT_FIELD_NAMES) initial[name] = "";
    return initial;
  });
  const [files, setFiles] = useState<Record<FileFieldName, File | null>>({
    licenceFile: null,
    signatoryIdFile: null,
    otherFile: null,
  });
  const [stageIndex, setStageIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Focus and the screen-reader announcement only make sense on a stage
  // change; moving focus on first mount would hijack the page load.
  const firstRenderRef = useRef(true);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    headingRef.current?.focus();
    setAnnounce(stepText(stageIndex));
  }, [stageIndex]);

  function setValue(name: string, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function setFile(name: FileFieldName, file: File | null) {
    setFiles((prev) => ({ ...prev, [name]: file }));
  }

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

  function goToStage(index: number) {
    setStageIndex(index);
    setAnnounce(stepText(index));
  }

  function handleBack() {
    goToStage(stageIndex - 1);
  }

  function handleNext() {
    const key = STAGES[stageIndex].key;
    const errors = validateStage(key, values, files);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setAnnounce(PARTNER_APPLY.fixErrorsNotice);
      return;
    }
    setFieldErrors({});
    goToStage(stageIndex + 1);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    // Enter inside a field on an earlier stage submits the form natively;
    // treat it as "Next" so no stage is skipped and errors stay visible.
    if (stageIndex < STAGES.length - 1) {
      handleNext();
      return;
    }

    const reviewErrors = validateStage("review", values, files);
    if (Object.keys(reviewErrors).length > 0) {
      setFieldErrors(reviewErrors);
      setAnnounce(PARTNER_APPLY.fixErrorsNotice);
      return;
    }
    setFieldErrors({});

    // Hidden sections still submit with noValidate, so the FormData captures
    // the hidden inputs, the honeypot and every mounted text field.
    const data = new FormData(event.currentTarget);

    // The file inputs are empty once a file is chosen (state holds the File),
    // so the real files are appended explicitly.
    for (const name of FILE_FIELD_NAMES) {
      const file = files[name];
      if (file) data.set(name, file);
    }

    // Client-side file checks only spare a round trip; the server re-checks.
    const uploadErrors: Record<string, string> = {};
    for (const name of FILE_FIELD_NAMES) {
      const file = files[name];
      if (file && isPresentFile(file)) {
        const problem = validateUpload(file);
        if (problem) uploadErrors[name] = problem;
      }
    }
    if (Object.keys(uploadErrors).length > 0) {
      setFieldErrors(uploadErrors);
      setStageIndex(STAGES.findIndex((stage) => stage.key === "licence"));
      setAnnounce(PARTNER_APPLY.fixErrorsNotice);
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
        if (Object.keys(next).length === 0) {
          setFormError(GENERIC_SUBMIT_ERROR);
        } else {
          // Show the stage that holds the first rejected field.
          const target = STAGES.findIndex(
            (stage) =>
              stage.fields.some((field) => field in next) ||
              (stage.key === "licence" && FILE_FIELD_NAMES.some((name) => name in next)),
          );
          if (target >= 0) goToStage(target);
        }
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
  // Mirrors the ui Input classes so the native country <select> looks identical.
  const selectClass =
    "flex h-11 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-sm ring-offset-background transition-colors placeholder:text-muted-foreground hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50";

  const companyStage = (
    <>
      <div className="space-y-2">
        <Label htmlFor="companyLegalName">{PARTNER_APPLY.labels.companyLegalName}</Label>
        <Input
          id="companyLegalName"
          name="companyLegalName"
          required
          maxLength={200}
          className={inputClass}
          value={values.companyLegalName}
          onChange={(event) => setValue("companyLegalName", event.target.value)}
          {...validityProps("companyLegalName")}
        />
        {fieldError("companyLegalName")}
      </div>
      <div className="space-y-2">
        <Label htmlFor="tradingName">{PARTNER_APPLY.labels.tradingName}</Label>
        <Input
          id="tradingName"
          name="tradingName"
          maxLength={200}
          className={inputClass}
          value={values.tradingName}
          onChange={(event) => setValue("tradingName", event.target.value)}
          {...validityProps("tradingName")}
        />
        {fieldError("tradingName")}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="country">{PARTNER_APPLY.labels.country}</Label>
          <select
            id="country"
            name="country"
            required
            autoComplete="country-name"
            className={selectClass}
            value={values.country}
            onChange={(event) => setValue("country", event.target.value)}
            {...validityProps("country")}
          >
            <option value="">{PARTNER_APPLY.countryPlaceholder}</option>
            {COUNTRIES.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.countries.map((country) => (
                  <option key={country} value={country}>
                    {country}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {fieldError("country")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="city">{PARTNER_APPLY.labels.city}</Label>
          <Input
            id="city"
            name="city"
            required
            maxLength={100}
            autoComplete="address-level2"
            list="city-suggestions"
            className={inputClass}
            value={values.city}
            onChange={(event) => setValue("city", event.target.value)}
            {...validityProps("city")}
          />
          {/* Suggestions only — the datalist never restricts free typing. */}
          <datalist id="city-suggestions">
            {getCitySuggestions(values.country).map((city) => (
              <option key={city} value={city} />
            ))}
          </datalist>
          {fieldError("city")}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">{PARTNER_APPLY.labels.address}</Label>
        <Textarea
          id="address"
          name="address"
          required
          maxLength={500}
          rows={2}
          value={values.address}
          onChange={(event) => setValue("address", event.target.value)}
          {...validityProps("address")}
        />
        {fieldError("address")}
      </div>
      <div className="space-y-2">
        <Label htmlFor="website">{PARTNER_APPLY.labels.website}</Label>
        <Input
          id="website"
          name="website"
          type="url"
          maxLength={300}
          placeholder="https://example.com"
          className={inputClass}
          value={values.website}
          onChange={(event) => setValue("website", event.target.value)}
          {...validityProps("website")}
        />
        {fieldError("website")}
      </div>
      <div className="space-y-2">
        <Label htmlFor="notes">{PARTNER_APPLY.labels.notes}</Label>
        <Textarea
          id="notes"
          name="notes"
          maxLength={2000}
          rows={3}
          value={values.notes}
          onChange={(event) => setValue("notes", event.target.value)}
          {...validityProps("notes")}
        />
        {fieldError("notes")}
      </div>
    </>
  );

  const licenceStage = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="licenceNumber">{PARTNER_APPLY.labels.licenceNumber}</Label>
          <Input
            id="licenceNumber"
            name="licenceNumber"
            required
            maxLength={100}
            className={inputClass}
            value={values.licenceNumber}
            onChange={(event) => setValue("licenceNumber", event.target.value)}
            {...validityProps("licenceNumber")}
          />
          {fieldError("licenceNumber")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="licenceAuthority">{PARTNER_APPLY.labels.licenceAuthority}</Label>
          <Input
            id="licenceAuthority"
            name="licenceAuthority"
            required
            maxLength={150}
            className={inputClass}
            value={values.licenceAuthority}
            onChange={(event) => setValue("licenceAuthority", event.target.value)}
            {...validityProps("licenceAuthority")}
          />
          {fieldError("licenceAuthority")}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="licenceExpiry">{PARTNER_APPLY.labels.licenceExpiry}</Label>
        <Input
          id="licenceExpiry"
          name="licenceExpiry"
          type="date"
          required
          className={inputClass}
          value={values.licenceExpiry}
          onChange={(event) => setValue("licenceExpiry", event.target.value)}
          {...validityProps("licenceExpiry")}
        />
        {fieldError("licenceExpiry")}
      </div>
      {FILE_FIELD_NAMES.map((name) => {
        const file = files[name];
        return (
          <div key={name} className="space-y-2">
            <Label htmlFor={name}>{PARTNER_APPLY.labels[name]}</Label>
            {/* A file input cannot be repopulated with a chosen File, so the
                File lives in component state; once chosen, the input is
                replaced by a summary row whose Replace button clears the
                state and remounts the empty input. */}
            {file === null ? (
              <>
                <Input
                  id={name}
                  name={name}
                  type="file"
                  required={name === "licenceFile"}
                  accept={FILE_INPUT_ACCEPT}
                  className="h-11 py-2"
                  onChange={(event) => setFile(name, event.target.files?.[0] ?? null)}
                  {...validityProps(name)}
                />
                <p className="text-sm text-muted-foreground">{PARTNER_APPLY.fileRules}</p>
              </>
            ) : (
              <div className="flex h-11 items-center justify-between gap-3 rounded-lg border border-input bg-card px-3 text-sm shadow-sm">
                <span className="truncate">
                  {file.name} ({formatFileSize(file.size)})
                </span>
                <button
                  type="button"
                  className="shrink-0 font-medium text-primary underline underline-offset-4"
                  aria-label={`${PARTNER_APPLY.replaceFileLabel} ${PARTNER_APPLY.labels[name]}`}
                  onClick={() => setFile(name, null)}
                >
                  {PARTNER_APPLY.replaceFileLabel}
                </button>
              </div>
            )}
            {fieldError(name)}
          </div>
        );
      })}
    </>
  );

  const contactsStage = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="contactName">{PARTNER_APPLY.labels.contactName}</Label>
          <Input
            id="contactName"
            name="contactName"
            required
            maxLength={150}
            autoComplete="name"
            className={inputClass}
            value={values.contactName}
            onChange={(event) => setValue("contactName", event.target.value)}
            {...validityProps("contactName")}
          />
          {fieldError("contactName")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="contactRole">{PARTNER_APPLY.labels.contactRole}</Label>
          <Input
            id="contactRole"
            name="contactRole"
            maxLength={150}
            autoComplete="organization-title"
            className={inputClass}
            value={values.contactRole}
            onChange={(event) => setValue("contactRole", event.target.value)}
            {...validityProps("contactRole")}
          />
          {fieldError("contactRole")}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="contactEmail">{PARTNER_APPLY.labels.contactEmail}</Label>
          <Input
            id="contactEmail"
            name="contactEmail"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            className={inputClass}
            value={values.contactEmail}
            onChange={(event) => setValue("contactEmail", event.target.value)}
            {...validityProps("contactEmail")}
          />
          {fieldError("contactEmail")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="contactPhone">{PARTNER_APPLY.labels.contactPhone}</Label>
          <Input
            id="contactPhone"
            name="contactPhone"
            type="tel"
            required
            autoComplete="tel"
            placeholder="+374 91 000000"
            className={inputClass}
            value={values.contactPhone}
            onChange={(event) => setValue("contactPhone", event.target.value)}
            {...validityProps("contactPhone")}
          />
          <p className="text-sm text-muted-foreground">{PARTNER_APPLY.contactPhoneHelper}</p>
          {fieldError("contactPhone")}
        </div>
      </div>

      <p className="pt-2 text-sm font-medium text-muted-foreground">{PARTNER_APPLY.labels.secondContact}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="secondContactName">{PARTNER_APPLY.labels.secondContactName}</Label>
          <Input
            id="secondContactName"
            name="secondContactName"
            maxLength={150}
            className={inputClass}
            value={values.secondContactName}
            onChange={(event) => setValue("secondContactName", event.target.value)}
            {...validityProps("secondContactName")}
          />
          {fieldError("secondContactName")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="secondContactEmail">{PARTNER_APPLY.labels.secondContactEmail}</Label>
          <Input
            id="secondContactEmail"
            name="secondContactEmail"
            type="email"
            maxLength={254}
            className={inputClass}
            value={values.secondContactEmail}
            onChange={(event) => setValue("secondContactEmail", event.target.value)}
            {...validityProps("secondContactEmail")}
          />
          {fieldError("secondContactEmail")}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="secondContactPhone">{PARTNER_APPLY.labels.secondContactPhone}</Label>
        <Input
          id="secondContactPhone"
          name="secondContactPhone"
          type="tel"
          className={inputClass}
          value={values.secondContactPhone}
          onChange={(event) => setValue("secondContactPhone", event.target.value)}
          {...validityProps("secondContactPhone")}
        />
        {fieldError("secondContactPhone")}
      </div>
    </>
  );

  const reviewStage = (
    <>
      <p className="text-sm text-muted-foreground">{PARTNER_APPLY.reviewHelper}</p>
      {STAGES.slice(0, 3).map((stage, index) => (
        <div key={stage.key} className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">{PARTNER_APPLY.sections[stage.key]}</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${PARTNER_APPLY.editLabel} ${PARTNER_APPLY.sections[stage.key]}`}
              onClick={() => goToStage(index)}
            >
              {PARTNER_APPLY.editLabel}
            </Button>
          </div>
          <dl className="space-y-2 text-sm">
            {stage.fields.map((field) => (
              <div key={field} className="grid gap-1 sm:grid-cols-[minmax(0,14rem)_1fr]">
                <dt className="text-muted-foreground">{FIELD_LABELS[field] ?? field}</dt>
                <dd className="break-words">{(values[field] ?? "").trim() || PARTNER_APPLY.notProvided}</dd>
              </div>
            ))}
            {stage.key === "licence" &&
              FILE_FIELD_NAMES.map((name) => {
                const file = files[name];
                return (
                  <div key={name} className="grid gap-1 sm:grid-cols-[minmax(0,14rem)_1fr]">
                    <dt className="text-muted-foreground">{PARTNER_APPLY.labels[name]}</dt>
                    <dd className="break-words">
                      {file ? `${file.name} (${formatFileSize(file.size)})` : PARTNER_APPLY.notProvided}
                    </dd>
                  </div>
                );
              })}
          </dl>
        </div>
      ))}

      <fieldset className="space-y-4">
        <legend className="text-lg font-semibold">{PARTNER_APPLY.sections.consent}</legend>
        {CONSENT_FIELD_NAMES.map((name) => (
          <div key={name} className="space-y-2">
            <div className="flex items-start gap-3">
              <input
                id={name}
                name={name}
                type="checkbox"
                value="true"
                required
                checked={values[name] === "true"}
                onChange={(event) => setValue(name, event.target.checked ? "true" : "")}
                className="mt-0.5 h-5 w-5 shrink-0 rounded border border-input accent-primary"
                {...validityProps(name)}
              />
              <Label htmlFor={name} className="text-sm font-normal leading-relaxed">
                {PARTNER_APPLY.labels[name]}
                {" — "}
                see the{" "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener"
                  className="text-primary underline underline-offset-4"
                >
                  {TERMS_OF_USE.title}
                </a>{" "}
                and the{" "}
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener"
                  className="text-primary underline underline-offset-4"
                >
                  {PRIVACY_NOTICE.title}
                </a>
                .
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
    </>
  );

  const stageContent: Record<StageKey, React.ReactNode> = {
    company: companyStage,
    licence: licenceStage,
    contacts: contactsStage,
    review: reviewStage,
  };

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      encType="multipart/form-data"
      aria-busy={submitting}
      className="space-y-10"
    >
      {/* Abuse tripwires: signed token + consent version travel as hidden
          inputs; the honeypot is invisible to humans and skipped by keyboard. */}
      <input type="hidden" name="formToken" value={formToken} />
      <input type="hidden" name="consentVersion" value={CONSENT_VERSION} />
      <div className="hidden" aria-hidden="true">
        <Label htmlFor={HONEYPOT_FIELD_NAME}>Company fax</Label>
        <Input id={HONEYPOT_FIELD_NAME} name={HONEYPOT_FIELD_NAME} type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <nav aria-label={PARTNER_APPLY.progressLabel} className="space-y-3">
        <ol className="flex flex-wrap gap-2">
          {STAGES.map((stage, index) => (
            <li
              key={stage.key}
              aria-current={index === stageIndex ? "step" : undefined}
              className={
                index === stageIndex
                  ? "rounded-full border border-border px-3 py-1 text-sm font-medium text-primary"
                  : "rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
              }
            >
              {index < stageIndex ? "✓ " : ""}
              {PARTNER_APPLY.sections[stage.key]}
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted-foreground">{stepText(stageIndex)}</p>
      </nav>

      {/* Polite announcements of stage changes and validation failures; the
          assertive role="status" is reserved for the success view. */}
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>

      {/* All stages stay mounted so their inputs still submit; inactive ones
          are only visually hidden. */}
      {STAGES.map((stage, index) => (
        <section
          key={stage.key}
          hidden={index !== stageIndex}
          aria-labelledby={`stage-${stage.key}-heading`}
          className="space-y-8"
        >
          <h2
            id={`stage-${stage.key}-heading`}
            tabIndex={-1}
            ref={index === stageIndex ? headingRef : undefined}
            className="text-lg font-semibold focus:outline-none"
          >
            {PARTNER_APPLY.sections[stage.key]}
          </h2>
          <div className="space-y-4">{stageContent[stage.key]}</div>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        {stageIndex > 0 && (
          <Button type="button" variant="outline" className="h-11 px-6" onClick={handleBack}>
            {PARTNER_APPLY.backLabel}
          </Button>
        )}
        {stageIndex < STAGES.length - 1 && (
          <Button type="button" className="h-11 px-6" onClick={handleNext}>
            {PARTNER_APPLY.nextLabel}
          </Button>
        )}
      </div>
    </form>
  );
}
