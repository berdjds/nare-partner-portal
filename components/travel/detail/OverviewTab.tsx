"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { badgeStatusTextStyles } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDisplayDateRange } from "@/lib/travel/engine/dates";
import DateField from "../DateField";
import { apiError, formatDateTime, parseJson } from "../utils";
import TravelerSetupEditor from "../TravelerSetupEditor";
import type { TravelerSetupView } from "../types";
import type { DetailContext } from "./RequestDetail";

/** e.g. "2 adults · 2 children (ages 4, 7) · 4 paying" — ages only when recorded. */
function travelerSummary(t: TravelerSetupView): string {
  const parts = [`${t.adults} adults`, `${t.children} children`];
  if (t.children > 0 && t.childAges?.length) {
    parts[parts.length - 1] = `${t.children} children (ages ${t.childAges.join(", ")})`;
  }
  if (t.infants) parts.push(`${t.infants} infants`);
  parts.push(`${t.paying} paying`);
  if (t.complimentary) parts.push(`${t.complimentary} complimentary`);
  if (t.leaders) parts.push(`${t.leaders} leaders`);
  if (t.staff) parts.push(`${t.staff} staff`);
  return parts.join(" · ");
}

export default function OverviewTab({ ctx }: { ctx: DetailContext }) {
  const { toast } = useToast();
  const { detail } = ctx;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: detail.title,
    destinations: parseJson<string[]>(detail.destinations, []).join(", "),
    startDate: detail.startDate,
    endDate: detail.endDate,
    agencyRef: detail.agencyRef ?? "",
    roomPrefs: detail.roomPrefs ?? "",
    flightDetails: detail.flightDetails ?? "",
    notes: detail.notes ?? "",
    travelers: parseJson<TravelerSetupView>(detail.travelers, {
      adults: 0,
      children: 0,
      infants: 0,
      childAges: [],
      paying: 0,
      complimentary: 0,
      leaders: 0,
      staff: 0,
    }),
  });

  // Re-hydrate the form when the detail reloads underneath us.
  useEffect(() => {
    if (!editing) {
      setForm({
        title: detail.title,
        destinations: parseJson<string[]>(detail.destinations, []).join(", "),
        startDate: detail.startDate,
        endDate: detail.endDate,
        agencyRef: detail.agencyRef ?? "",
        roomPrefs: detail.roomPrefs ?? "",
        flightDetails: detail.flightDetails ?? "",
        notes: detail.notes ?? "",
        travelers: parseJson(detail.travelers, form.travelers),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await axios.patch(`/api/travel/requests/${detail.id}`, {
        expectedRevision: detail.revision,
        patch: {
          title: form.title,
          destinations: form.destinations
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean),
          startDate: form.startDate,
          endDate: form.endDate,
          agencyRef: form.agencyRef || null,
          roomPrefs: form.roomPrefs || null,
          flightDetails: form.flightDetails || null,
          notes: form.notes || null,
          travelers: form.travelers,
        },
      });
      toast("Request updated", "success");
      setEditing(false);
      ctx.refresh();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        toast("This request was edited elsewhere — refreshed the latest data. Review and save again.", "error");
        setEditing(false);
        ctx.refresh();
      } else {
        toast(apiError(err, "Failed to update request"), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  const travelers = parseJson<TravelerSetupView>(detail.travelers, form.travelers);
  const destinations = parseJson<string[]>(detail.destinations, []);
  const invalidDates = !(form.endDate > form.startDate);

  return (
    <>
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Request details</CardTitle>
            <CardDescription>
              Revision {detail.revision} · created {formatDateTime(detail.createdAt)}
            </CardDescription>
          </div>
          {ctx.canEditRequest && !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!editing ? (
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Field label="Title" value={detail.title} />
            <Field label="Agency ref" value={detail.agencyRef} />
            <Field label="Destinations" value={destinations.length ? destinations.join(", ") : null} />
            <Field label="Dates" value={formatDisplayDateRange(detail.startDate, detail.endDate)} />
            <Field
              label="Travelers"
              value={travelerSummary(travelers)}
            />
            <Field label="Room preferences" value={detail.roomPrefs} />
            <Field label="Flight details" value={detail.flightDetails} />
            <Field label="Notes" value={detail.notes} />
            <Field label="Agency contact" value={
              [detail.agency.contactName, detail.agency.contactEmail, detail.agency.contactPhone]
                .filter(Boolean)
                .join(" · ") || null
            } />
          </dl>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Title</Label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              </div>
              <div>
                <Label>Agency ref</Label>
                <Input value={form.agencyRef} onChange={(e) => setForm({ ...form, agencyRef: e.target.value })} />
              </div>
              <div>
                <Label>Destinations (comma separated)</Label>
                <Input value={form.destinations} onChange={(e) => setForm({ ...form, destinations: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Start</Label>
                  <DateField value={form.startDate} onChange={(iso) => setForm({ ...form, startDate: iso })} />
                </div>
                <div>
                  <Label>End</Label>
                  {/* min pins the end to the start; strict "end after start" stays on invalidDates below. */}
                  <DateField value={form.endDate} min={form.startDate} onChange={(iso) => setForm({ ...form, endDate: iso })} />
                </div>
              </div>
            </div>
            {invalidDates && <p className={cn("text-xs", badgeStatusTextStyles.danger)}>End date must be after the start date.</p>}
            <div>
              <Label>Travelers</Label>
              <TravelerSetupEditor
                value={form.travelers}
                onChange={(travelers) => setForm({ ...form, travelers })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Room preferences</Label>
                <Textarea rows={2} value={form.roomPrefs} onChange={(e) => setForm({ ...form, roomPrefs: e.target.value })} />
              </div>
              <div>
                <Label>Flight details</Label>
                <Textarea rows={2} value={form.flightDetails} onChange={(e) => setForm({ ...form, flightDetails: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || invalidDates}>
                {saving ? "Saving..." : "Save changes"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
    {ctx.isAdmin && <DeleteRequestCard ctx={ctx} />}
    </>
  );
}

/** ADMIN-only hard delete (v0.12.0) — test/junk requests, gone for good. */
function DeleteRequestCard({ ctx }: { ctx: DetailContext }) {
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { detail } = ctx;

  async function handleDelete() {
    setDeleting(true);
    try {
      await axios.delete(`/api/travel/requests/${detail.id}`);
      toast(`Deleted ${detail.packageCode}`, "success");
      window.location.href = "/travel";
    } catch (err) {
      toast(apiError(err, "Delete failed"), "error");
      setDeleting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <Card className="mt-4 border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base">Danger zone</CardTitle>
        <CardDescription>Hard-deletes this request with all versions, documents and notifications.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
          Delete request
        </Button>
      </CardContent>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete request {detail.packageCode}?</DialogTitle>
            <DialogDescription>
              Deletes “{detail.title}” with all its versions, scenarios, itinerary, documents and notifications.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value || "—"}</dd>
    </div>
  );
}
