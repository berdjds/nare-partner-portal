"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Inbox, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { QUOTE_STATUSES } from "@/lib/travel/contracts";
import { formatDisplayDateRange, nightsBetween } from "@/lib/travel/engine/dates";
import { PageHeader } from "./TravelShell";
import DateField from "./DateField";
import TravelerSetupEditor from "./TravelerSetupEditor";
import { StatusBadge, apiError } from "./utils";
import type { Agency, RequestListItem, TemplateView, TravelerSetupView } from "./types";

const EMPTY_TRAVELERS: TravelerSetupView = {
  adults: 2,
  children: 0,
  infants: 0,
  childAges: [],
  // Operator default: one paying traveler until adjusted — deliberately not
  // adults+children, so the auto-follow logic in TravelerSetupEditor leaves it alone.
  paying: 1,
  complimentary: 0,
  leaders: 0,
  staff: 0,
};

interface RequestsListProps {
  role: string;
  userId: string;
  permissions: string[];
}

export default function RequestsList({ role, userId, permissions }: RequestsListProps) {
  const { toast } = useToast();
  const [requests, setRequests] = useState<RequestListItem[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [onlyMine, setOnlyMine] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<RequestListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const [form, setForm] = useState({
    agencyId: "",
    title: "",
    startDate: "",
    endDate: "",
    notes: "",
    travelers: { ...EMPTY_TRAVELERS },
  });

  // W2: the create dialog also requires the travel.create permission the
  // server enforces on POST /api/travel/requests.
  const canCreate = (role === "ADMIN" || role === "ADVISOR") && permissions.includes("travel.create");
  const isAdmin = role === "ADMIN";
  const invalidDates = form.startDate !== "" && form.endDate !== "" && !(form.endDate > form.startDate);

  // Trip length filters the offered template versions (v0.11.0); before the
  // dates are set, all active versions are listed so the option is visible.
  const tripNights =
    form.startDate && form.endDate && !invalidDates ? nightsBetween(form.startDate, form.endDate) : null;
  const matchingTemplates = !templates
    ? []
    : templates.flatMap((t) =>
        t.versions
          .filter((v) => v.status === "ACTIVE" && (tripNights === null || v.nights === tripNights))
          .map((v) => ({ template: t, version: v })),
      );

  const fetchRequests = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status !== "ALL") params.set("status", status);
      if (onlyMine && role !== "ADVISOR") params.set("ownerId", userId);
      const res = await axios.get(`/api/travel/requests?${params.toString()}`);
      setRequests(res.data);
    } catch (err) {
      toast(apiError(err, "Failed to load requests"), "error");
    }
  }, [q, status, onlyMine, role, userId, toast]);

  // Debounce the search box; status/mine changes refetch immediately.
  useEffect(() => {
    const t = setTimeout(fetchRequests, 300);
    return () => clearTimeout(t);
  }, [fetchRequests]);

  useEffect(() => {
    axios
      .get("/api/travel/agencies")
      .then((res) => setAgencies(res.data))
      .catch(() => toast("Failed to load agencies", "error"));
  }, [toast]);

  // Templates load lazily with the dialog — they only matter when creating.
  useEffect(() => {
    if (!createOpen || templates !== null) return;
    axios
      .get("/api/travel/templates")
      .then((res) => setTemplates(res.data))
      .catch(() => toast("Failed to load templates", "error"));
  }, [createOpen, templates, toast]);

  // A date change can invalidate the picked template version; drop it rather
  // than silently instantiating a version that no longer matches the trip.
  useEffect(() => {
    if (templateVersionId && !matchingTemplates.some((m) => m.version.id === templateVersionId)) {
      setTemplateVersionId("");
    }
  }, [templateVersionId, matchingTemplates]);

  function pickTemplate(value: string) {
    // Radix Select forbids empty-string item values, hence the NONE sentinel.
    const versionId = value === "NONE" ? "" : value;
    setTemplateVersionId(versionId);
    const match = matchingTemplates.find((m) => m.version.id === versionId);
    if (match) setForm((f) => ({ ...f, title: match.template.name }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.agencyId) {
      toast("Pick an agency", "error");
      return;
    }
    // DateField has no native `required` enforcement, so guard the dates here.
    if (!form.startDate || !form.endDate) {
      toast("Pick start and end dates", "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        agencyId: form.agencyId,
        title: form.title,
        startDate: form.startDate,
        endDate: form.endDate,
        travelers: form.travelers,
        notes: form.notes || null,
      };
      const match = matchingTemplates.find((m) => m.version.id === templateVersionId);
      const res = match
        ? await axios.post(`/api/travel/templates/${match.template.id}/instantiate`, {
            ...payload,
            templateVersionId: match.version.id,
          })
        : await axios.post("/api/travel/requests", payload);
      toast(`Created ${res.data.request.packageCode}`, "success");
      window.location.href = `/travel/requests/${res.data.request.id}`;
    } catch (err) {
      toast(apiError(err, "Failed to create request"), "error");
      setSaving(false);
    }
  }

  function setTravelers(travelers: TravelerSetupView) {
    setForm((f) => ({ ...f, travelers }));
  }

  async function handleDelete() {
    if (!deleteFor) return;
    setDeleting(true);
    try {
      await axios.delete(`/api/travel/requests/${deleteFor.id}`);
      toast(`Deleted ${deleteFor.packageCode}`, "success");
      setRequests((rs) => rs.filter((r) => r.id !== deleteFor.id));
      setDeleteFor(null);
    } catch (err) {
      toast(apiError(err, "Delete failed"), "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Travel Requests"
        subtitle={role === "ADVISOR" ? "Your B2B quotation requests." : "All B2B quotation requests and packages."}
        actions={
          canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> New request
            </Button>
          ) : undefined
        }
      />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Input
            placeholder="Search code, title, agency..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {QUOTE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {role !== "ADVISOR" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)} />
              Owned by me
            </label>
          )}
        </CardContent>
      </Card>

      {requests.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No requests found"
          description={q || status !== "ALL" ? "Try widening the search or clearing the filters." : "Requests you create or receive will show up here."}
          action={
            canCreate ? (
              <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> Create your first request
              </Button>
            ) : undefined
          }
        />
      ) : (
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Package code</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Agency</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                {isAdmin && <TableHead className="pr-4" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {requests.map((r) => (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => (window.location.href = `/travel/requests/${r.id}`)}
                >
                  <TableCell className="pl-4 font-mono text-xs">{r.packageCode}</TableCell>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell>
                    {r.agency.shortCode} — {r.agency.name}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDisplayDateRange(r.startDate, r.endDate)}
                  </TableCell>
                  <TableCell>{r.owner.name || r.owner.email}</TableCell>
                  <TableCell>{r.validator ? r.validator.name || r.validator.email : "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(r.updatedAt).toLocaleString()}</TableCell>
                  {isAdmin && (
                    <TableCell className="pr-4 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete ${r.packageCode}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteFor(r);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New travel request</DialogTitle>
            <DialogDescription>The package code is generated from the agency and today&apos;s date.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agency, dates &amp; template</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Label>Agency</Label>
                  <Select value={form.agencyId} onValueChange={(v) => setForm({ ...form, agencyId: v })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select agency" />
                    </SelectTrigger>
                    <SelectContent>
                      {agencies.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.shortCode} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Start date</Label>
                  <DateField value={form.startDate} onChange={(iso) => setForm({ ...form, startDate: iso })} />
                </div>
                <div>
                  <Label>End date</Label>
                  {/* End date can't precede the start date; the picker disables those days. */}
                  <DateField
                    value={form.endDate}
                    onChange={(iso) => setForm({ ...form, endDate: iso })}
                    min={form.startDate || undefined}
                  />
                </div>
                {templates !== null && (
                  <div className="sm:col-span-2">
                    <Label>Template</Label>
                    <Select value={templateVersionId || "NONE"} onValueChange={pickTemplate}>
                      <SelectTrigger>
                        <SelectValue placeholder="No template" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">No template</SelectItem>
                        {matchingTemplates.map(({ template: t, version: v }) => (
                          <SelectItem key={v.id} value={v.id}>
                            {t.code} — {t.name} — {v.nights} nights (v{v.versionNo})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {tripNights !== null && matchingTemplates.length === 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        No active template covers {tripNights} nights.
                      </p>
                    )}
                    {tripNights === null && matchingTemplates.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        The list is filtered to the trip length once the dates are set.
                      </p>
                    )}
                  </div>
                )}
                <div className="sm:col-span-2">
                  <Label>Title</Label>
                  <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
                </div>
              </div>
              {invalidDates && <p className="mt-2 text-xs text-red-600">End date must be after the start date.</p>}
            </div>
            <Separator />
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Travelers</p>
              <TravelerSetupEditor value={form.travelers} onChange={setTravelers} />
            </div>
            <Separator />
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notes</p>
              <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={saving || invalidDates}>
                {saving ? "Creating..." : "Create request"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteFor !== null} onOpenChange={(o) => !o && setDeleteFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete request {deleteFor?.packageCode}?</DialogTitle>
            <DialogDescription>
              Deletes “{deleteFor?.title}” with all its versions, scenarios, itinerary, documents and notifications.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? "Deleting..." : "Delete request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
