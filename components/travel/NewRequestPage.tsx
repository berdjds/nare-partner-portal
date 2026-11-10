"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { badgeStatusTextStyles } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { nightsBetween, formatDisplayDateRange } from "@/lib/travel/engine/dates";
import { EMPTY_NEW_REQUEST, draftKey, firstErrorId, hasErrors, validateNewRequest, type FieldErrors, type NewRequestForm } from "@/lib/travel/new-request-form";
import { PageHeader } from "./TravelShell";
import DateField from "./DateField";
import TravelerSetupEditor from "./TravelerSetupEditor";
import { apiError } from "./utils";
import type { Agency, TemplateView, TravelerSetupView } from "./types";

const STEPS = [
  { id: "nr-sec-context", label: "Agency" },
  { id: "nr-sec-trip", label: "Dates & template" },
  { id: "nr-sec-travelers", label: "Travellers" },
  { id: "nr-sec-notes", label: "Client requirements" },
  { id: "nr-sec-review", label: "Review" },
] as const;

/** Error text under a field, announced to assistive technology and linked from the control. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <p id={`${id}-error`} className={`mt-1 text-xs font-medium ${badgeStatusTextStyles.danger}`}>{message}</p>;
}
const describedBy = (id: string, message?: string) => (message ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {});

export default function NewRequestPage({ userId }: { userId: string }) {
  const { toast } = useToast();
  const DRAFT_KEY = draftKey(userId);
  const leaving = useRef(false); // set while we navigate away on purpose, so the unload prompt stays quiet
  const [form, setForm] = useState<NewRequestForm>({ ...EMPTY_NEW_REQUEST });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [templatesFailed, setTemplatesFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState(false);
  const inFlight = useRef(false); // synchronous guard: a second click in the same tick cannot pass

  // Entered values survive a reload or an accidental back navigation (kept in this tab only).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as NewRequestForm;
        setForm({ ...EMPTY_NEW_REQUEST, ...saved, travelers: { ...EMPTY_NEW_REQUEST.travelers, ...saved.travelers } });
        setDirty(true);
        setRestored(true);
      }
    } catch { /* unavailable or corrupt storage: start empty */ }
  }, []);
  useEffect(() => {
    if (!dirty) return;
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch { /* ignore */ }
  }, [form, dirty]);
  useEffect(() => {
    if (!dirty || submitting) return;
    const warn = (e: BeforeUnloadEvent) => { if (leaving.current) return; e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitting]);

  useEffect(() => {
    axios.get("/api/travel/agencies").then((r) => setAgencies(r.data)).catch(() => toast("Failed to load agencies", "error"));
    axios.get("/api/travel/templates").then((r) => setTemplates(r.data)).catch(() => { setTemplatesFailed(true); toast("Failed to load templates", "error"); });
  }, [toast]);

  const update = useCallback((patch: Partial<NewRequestForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  }, []);

  // Live validation, shown for a field once touched or after a submit attempt.
  const allErrors = useMemo(() => validateNewRequest(form), [form]);
  const shown: FieldErrors = useMemo(() => {
    const out: FieldErrors = {};
    for (const k of Object.keys(allErrors) as Array<keyof FieldErrors>) if (touched[k] || errors[k]) out[k] = allErrors[k];
    return out;
  }, [allErrors, touched, errors]);
  const touch = (k: keyof FieldErrors) => setTouched((t) => ({ ...t, [k]: true }));

  const invalidDates = Boolean(allErrors.endDate) && Boolean(form.startDate) && Boolean(form.endDate);
  const tripNights = form.startDate && form.endDate && !invalidDates && !allErrors.startDate ? nightsBetween(form.startDate, form.endDate) : null;
  const matchingTemplates = useMemo(
    () => (templates ?? []).flatMap((t) => t.versions.filter((v) => v.status === "ACTIVE" && (tripNights === null || v.nights === tripNights)).map((v) => ({ template: t, version: v }))),
    [templates, tripNights],
  );
  // A date change can invalidate the chosen template version: drop it visibly, never silently instantiate a mismatch.
  const [templateDropped, setTemplateDropped] = useState(false);
  useEffect(() => {
    // Only judge the fit once the trip length is known: a half-entered date range must not drop the choice.
    if (form.templateVersionId && templates && tripNights !== null && !matchingTemplates.some((m) => m.version.id === form.templateVersionId)) {
      setForm((f) => ({ ...f, templateVersionId: "" }));
      setTemplateDropped(true);
    }
    if (form.templateVersionId && templatesFailed) {
      setForm((f) => ({ ...f, templateVersionId: "" }));
      setTemplateDropped(true);
    }
  }, [form.templateVersionId, matchingTemplates, templates, templatesFailed, tripNights]);

  const chosen = matchingTemplates.find((m) => m.version.id === form.templateVersionId);
  const agency = agencies.find((a) => a.id === form.agencyId);

  function pickTemplate(value: string) {
    const id = value === "NONE" ? "" : value;
    setTemplateDropped(false);
    const m = matchingTemplates.find((x) => x.version.id === id);
    update({ templateVersionId: id, ...(m && !form.title.trim() ? { title: m.template.name } : {}) });
  }

  function leave() {
    if (dirty && !window.confirm("Discard this request? What you entered will be lost.")) return;
    try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    leaving.current = true;
    setDirty(false);
    window.location.href = "/travel";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const found = validateNewRequest(form);
    if (hasErrors(found)) {
      setErrors(found);
      const id = firstErrorId(found);
      if (id) document.getElementById(id)?.focus();
      return;
    }
    inFlight.current = true;
    setSubmitting(true);
    try {
      const payload = {
        agencyId: form.agencyId,
        agencyRef: form.agencyRef.trim() || null,
        title: form.title.trim(),
        startDate: form.startDate,
        endDate: form.endDate,
        travelers: form.travelers,
        notes: form.notes.trim() || null,
        clientNotes: form.clientNotes.trim() || null,
      };
      const res = chosen
        ? await axios.post(`/api/travel/templates/${chosen.template.id}/instantiate`, { ...payload, templateVersionId: chosen.version.id })
        : await axios.post("/api/travel/requests", payload);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      leaving.current = true;
      setDirty(false);
      toast(`Created ${res.data.request.packageCode}`, "success");
      // A failed rule application is reported on the request page, never swallowed.
      const rulesFailed = Boolean(res.data.recalculation?.error);
      window.location.href = `/travel/requests/${res.data.request.id}${rulesFailed ? "?templateRules=failed" : ""}`;
      // inFlight stays true: the page is navigating away, a second submit must not pass.
    } catch (err) {
      toast(apiError(err, "Failed to create request"), "error");
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const errorList = (Object.keys(errors) as Array<keyof FieldErrors>).filter((k) => errors[k] && allErrors[k]);

  return (
    <>
      <PageHeader
        title="New travel request"
        subtitle="The package code is generated from the agency and today's date."
        actions={<Button type="button" variant="ghost" onClick={leave}><ArrowLeft /> Back to requests</Button>}
      />
      <nav aria-label="Sections" className="mb-4 flex gap-2 overflow-x-auto text-sm">
        {STEPS.map((s, i) => (
          <a key={s.id} href={`#${s.id}`} className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full border px-3 hover:bg-muted">
            <span className="me-2 text-xs text-muted-foreground">{i + 1}</span>{s.label}
          </a>
        ))}
      </nav>
      {restored && <p role="status" className="mb-4 rounded-lg border bg-muted/50 p-3 text-sm">We restored what you had entered. <button type="button" className="underline" onClick={() => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } setForm({ ...EMPTY_NEW_REQUEST }); setDirty(false); setRestored(false); setTouched({}); setErrors({}); }}>Start over</button></p>}
      {errorList.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" tabIndex={-1}>
          <p className="font-medium">Please fix {errorList.length} {errorList.length === 1 ? "field" : "fields"} before creating the request:</p>
          <ul className="mt-1 list-disc ps-5">{errorList.map((k) => <li key={k}>{allErrors[k]}</li>)}</ul>
        </div>
      )}

      <form onSubmit={submit} noValidate className="space-y-4 pb-24">
        <Card id="nr-sec-context">
          <CardHeader><CardTitle>1. Agency</CardTitle><CardDescription>Who the quotation is for.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label htmlFor="nr-agency">Agency</Label>
              <Select value={form.agencyId} onValueChange={(v) => { update({ agencyId: v }); touch("agencyId"); }}>
                <SelectTrigger id="nr-agency" {...describedBy("nr-agency", shown.agencyId)}><SelectValue placeholder="Select agency" /></SelectTrigger>
                <SelectContent>{agencies.map((a) => <SelectItem key={a.id} value={a.id}>{a.shortCode} — {a.name}</SelectItem>)}</SelectContent>
              </Select>
              <FieldError id="nr-agency" message={shown.agencyId} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="nr-agency-ref">Agency reference <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Input id="nr-agency-ref" value={form.agencyRef} onChange={(e) => update({ agencyRef: e.target.value })} onBlur={() => touch("agencyRef")} maxLength={200} {...describedBy("nr-agency-ref", shown.agencyRef)} />
              <FieldError id="nr-agency-ref" message={shown.agencyRef} />
            </div>
          </CardContent>
        </Card>

        <Card id="nr-sec-trip">
          <CardHeader><CardTitle>2. Dates &amp; template</CardTitle><CardDescription>A template fills the itinerary, tours, tickets and degustations and re-calculates when travellers or dates change.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="nr-start">Start date</Label>
              <DateField id="nr-start" value={form.startDate} invalid={Boolean(shown.startDate)} describedBy={shown.startDate ? "nr-start-error" : undefined} onChange={(iso) => { update({ startDate: iso }); touch("startDate"); }} />
              <FieldError id="nr-start" message={shown.startDate} />
            </div>
            <div>
              <Label htmlFor="nr-end">End date</Label>
              <DateField id="nr-end" value={form.endDate} invalid={Boolean(shown.endDate)} describedBy={shown.endDate ? "nr-end-error" : undefined} onChange={(iso) => { update({ endDate: iso }); touch("endDate"); }} min={form.startDate || undefined} />
              <FieldError id="nr-end" message={shown.endDate} />
            </div>
            {templates !== null && (
              <div className="sm:col-span-2">
                <Label htmlFor="nr-template">Template <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Select value={form.templateVersionId || "NONE"} onValueChange={pickTemplate}>
                  <SelectTrigger id="nr-template"><SelectValue placeholder="No template" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">No template</SelectItem>
                    {matchingTemplates.map(({ template: t, version: v }) => <SelectItem key={v.id} value={v.id}>{t.code} — {t.name} — {v.nights} nights (v{v.versionNo})</SelectItem>)}
                  </SelectContent>
                </Select>
                {tripNights !== null && matchingTemplates.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No active template covers {tripNights} nights.</p>}
                {tripNights === null && matchingTemplates.length > 0 && <p className="mt-1 text-xs text-muted-foreground">The list is filtered to the trip length once both dates are set.</p>}
                {templateDropped && <p role="status" className="mt-1 text-xs font-medium">The selected template was cleared ({templatesFailed ? "templates could not be loaded" : "it no longer fits the dates"}). The request will be created without it.</p>}
              </div>
            )}
            <div className="sm:col-span-2">
              <Label htmlFor="nr-title">Title</Label>
              <Input id="nr-title" value={form.title} onChange={(e) => update({ title: e.target.value })} onBlur={() => touch("title")} maxLength={220} {...describedBy("nr-title", shown.title)} />
              <FieldError id="nr-title" message={shown.title} />
            </div>
          </CardContent>
        </Card>

        <Card id="nr-sec-travelers">
          <CardHeader><CardTitle>3. Travellers</CardTitle><CardDescription>Adults and children with each child&apos;s age, then paying, complimentary, leaders and staff.</CardDescription></CardHeader>
          <CardContent>
            <div id="nr-travelers" role="group" aria-label="Traveller details" aria-describedby={shown.travelers ? "nr-travelers-error" : undefined} tabIndex={-1}>
              <TravelerSetupEditor value={form.travelers as TravelerSetupView} onChange={(t) => { update({ travelers: t as NewRequestForm["travelers"] }); touch("travelers"); }} />
            </div>
            <FieldError id="nr-travelers" message={shown.travelers} />
          </CardContent>
        </Card>

        <Card id="nr-sec-notes">
          <CardHeader><CardTitle>4. Client requirements</CardTitle><CardDescription>Keep what the agency can see apart from what stays inside Nare.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="nr-client-notes">Client messages and notes</Label>
              <Textarea id="nr-client-notes" rows={3} value={form.clientNotes} onChange={(e) => update({ clientNotes: e.target.value })} onBlur={() => touch("clientNotes")} {...describedBy("nr-client-notes", shown.clientNotes)} />
              <p className="mt-1 text-xs text-muted-foreground">Shared with the agency on this request.</p>
              <FieldError id="nr-client-notes" message={shown.clientNotes} />
            </div>
            <div>
              <Label htmlFor="nr-internal-notes">Internal notes <span className="font-normal text-muted-foreground">(staff only)</span></Label>
              <Textarea id="nr-internal-notes" rows={2} value={form.notes} onChange={(e) => update({ notes: e.target.value })} onBlur={() => touch("notes")} {...describedBy("nr-internal-notes", shown.notes)} />
              <p className="mt-1 text-xs text-muted-foreground">Never shown to the agency.</p>
              <FieldError id="nr-internal-notes" message={shown.notes} />
            </div>
          </CardContent>
        </Card>

        <Card id="nr-sec-review">
          <CardHeader><CardTitle>5. Review</CardTitle><CardDescription>Check the summary, then create the request.</CardDescription></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Agency</dt><dd>{agency ? `${agency.shortCode} — ${agency.name}` : "—"}</dd></div>
              <div><dt className="text-muted-foreground">Dates</dt><dd>{form.startDate && form.endDate && !allErrors.endDate ? `${formatDisplayDateRange(form.startDate, form.endDate)} (${tripNights} nights)` : "—"}</dd></div>
              <div><dt className="text-muted-foreground">Template</dt><dd>{chosen ? `${chosen.template.code} — ${chosen.template.name}` : "None"}</dd></div>
              <div><dt className="text-muted-foreground">Travellers</dt><dd>{form.travelers.adults} adults, {form.travelers.children} children, {form.travelers.paying} paying{form.travelers.leaders ? `, ${form.travelers.leaders} leaders` : ""}{form.travelers.staff ? `, ${form.travelers.staff} staff` : ""}</dd></div>
            </dl>
          </CardContent>
        </Card>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-3 backdrop-blur lg:start-60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-2">
            <Link href="/travel" onClick={(e) => { e.preventDefault(); leave(); }} className="inline-flex min-h-11 items-center px-3 text-sm underline">Cancel</Link>
            <Button type="submit" disabled={submitting} aria-busy={submitting}>{submitting ? "Creating…" : "Create request"}</Button>
          </div>
        </div>
      </form>
    </>
  );
}
