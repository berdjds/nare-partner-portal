"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { Library, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { addDays } from "@/lib/travel/engine/dates";
import DateField from "./DateField";
import { PageHeader } from "./TravelShell";
import { StateBadge, apiError, money } from "./utils";
import type { Agency, TemplateView, TemplateVersionView } from "./types";

interface TemplatesListProps {
  role: string;
  userId: string;
}

interface BatchResult {
  pax: number;
  valid: boolean;
  sell: string | null;
  perPayingPerson: string | null;
  issues: { code: string; severity: string; message: string }[];
}

export default function TemplatesList({ role }: TemplatesListProps) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [quoteCurrency, setQuoteCurrency] = useState("USD");
  const [instantiateFor, setInstantiateFor] = useState<TemplateView | null>(null);
  const [batchFor, setBatchFor] = useState<TemplateView | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteFor, setDeleteFor] = useState<TemplateView | null>(null);

  const isAdmin = role === "ADMIN";
  const canInstantiate = isAdmin || role === "ADVISOR";

  function reloadTemplates() {
    return axios
      .get("/api/travel/templates")
      .then((res) => setTemplates(res.data))
      .catch((err) => toast(apiError(err, "Failed to load templates"), "error"));
  }

  useEffect(() => {
    reloadTemplates();
    axios
      .get("/api/travel/agencies")
      .then((res) => setAgencies(res.data))
      .catch(() => null);
    axios
      .get("/api/travel/settings")
      .then((res) => {
        if (res.data?.activePolicy?.quoteCurrency) setQuoteCurrency(res.data.activePolicy.quoteCurrency);
      })
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  async function handleDuplicate(t: TemplateView) {
    try {
      const res = await axios.post(`/api/travel/templates/${t.id}/duplicate`);
      toast(`Duplicated ${t.code} → ${res.data.code}`, "success");
      await reloadTemplates();
    } catch (err) {
      toast(apiError(err, "Duplicate failed"), "error");
    }
  }

  return (
    <>
      <PageHeader
        title="Package templates"
        subtitle="Reusable packages; instantiate one into a request or manage content in the editor."
        actions={
          isAdmin ? (
            <Button onClick={() => setNewOpen(true)}>
              <Plus /> New template
            </Button>
          ) : undefined
        }
      />
      <div className="space-y-4">
        {templates.map((t) => (
          <Card key={t.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">
                    <span className="font-mono">{t.code}</span> — {t.name}
                  </CardTitle>
                  <CardDescription>{t.versions.length} version(s)</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {isAdmin && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => (window.location.href = `/travel/templates/${t.id}`)}
                      >
                        Edit
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleDuplicate(t)}>
                        Duplicate
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDeleteFor(t)}>
                        Delete
                      </Button>
                    </>
                  )}
                  {canInstantiate && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setBatchFor(t)}>
                        Batch pricing
                      </Button>
                      <Button size="sm" onClick={() => setInstantiateFor(t)}>
                        Instantiate
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Nights / days</TableHead>
                    <TableHead>Legacy markup</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Provenance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {t.versions.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell>v{v.versionNo}</TableCell>
                      <TableCell>
                        {v.nights} / {v.days}
                      </TableCell>
                      <TableCell>
                        {v.legacyMarkup ?? "—"}
                        {v.legacyMarkup && (
                          <span className="ms-1 text-xs text-muted-foreground">(legacy markup, informational only)</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={v.status === "ACTIVE" ? "success" : "neutral"}>{v.status}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{v.provenance ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ))}
        {templates.length === 0 && (
          <EmptyState
            icon={Library}
            title="No templates found"
            description="Reusable packages live here — create one, then instantiate it into requests."
            action={
              isAdmin ? (
                <Button variant="outline" size="sm" onClick={() => setNewOpen(true)}>
                  <Plus /> Create your first template
                </Button>
              ) : undefined
            }
          />
        )}
      </div>

      {instantiateFor && (
        <InstantiateDialog
          template={instantiateFor}
          agencies={agencies}
          onClose={() => setInstantiateFor(null)}
        />
      )}
      {batchFor && (
        <BatchDialog template={batchFor} quoteCurrency={quoteCurrency} onClose={() => setBatchFor(null)} />
      )}
      {newOpen && (
        <NewTemplateDialog
          onClose={() => setNewOpen(false)}
          onCreated={async () => {
            setNewOpen(false);
            await reloadTemplates();
          }}
        />
      )}
      {deleteFor && (
        <DeleteTemplateDialog
          template={deleteFor}
          onClose={() => setDeleteFor(null)}
          onDeleted={async () => {
            setDeleteFor(null);
            await reloadTemplates();
          }}
        />
      )}
    </>
  );
}

function NewTemplateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [nights, setNights] = useState(4);
  const [saving, setSaving] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await axios.post("/api/travel/templates", { code, name, nights });
      toast(`Created template ${code.trim().toUpperCase()}`, "success");
      await onCreated();
    } catch (err) {
      toast(apiError(err, "Failed to create template"), "error");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New template</DialogTitle>
          <DialogDescription>
            Creates the template with an empty v1 — add days, services and hotel scenarios in the editor.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Code</Label>
              <Input aria-label="Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ARM-S26-0405A"
                className="font-mono"
                required
              />
            </div>
            <div>
              <Label>Nights</Label>
              <Input aria-label="Nights"
                type="number"
                min={1}
                max={59}
                value={nights}
                onChange={(e) => setNights(Math.max(1, Number.parseInt(e.target.value || "1", 10) || 1))}
              />
              <p className="mt-1 text-xs text-muted-foreground">{nights + 1} day rows (arrival … departure)</p>
            </div>
            <div className="sm:col-span-2">
              <Label>Name</Label>
              <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Armenia highlights" required />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || !code.trim() || !name.trim()}>
              {saving ? "Creating..." : "Create template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTemplateDialog({
  template,
  onClose,
  onDeleted,
}: {
  template: TemplateView;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      await axios.delete(`/api/travel/templates/${template.id}`);
      toast(`Deleted template ${template.code}`, "success");
      await onDeleted();
    } catch (err) {
      toast(apiError(err, "Delete failed"), "error");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete template {template.code}?</DialogTitle>
          <DialogDescription>
            Deletes “{template.name}” and its {template.versions.length} version(s). Requests already created from
            it are not affected. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={busy}>
            {busy ? "Deleting..." : "Delete template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InstantiateDialog({
  template,
  agencies,
  onClose,
}: {
  template: TemplateView;
  agencies: Agency[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const activeVersion = template.versions.find((v) => v.status === "ACTIVE") ?? template.versions[0];
  const [versionId, setVersionId] = useState(activeVersion?.id ?? "");
  const [form, setForm] = useState({
    agencyId: "",
    title: template.name,
    startDate: "",
    endDate: "",
    notes: "",
    adults: 2,
    paying: 2,
  });
  const [saving, setSaving] = useState(false);

  const version: TemplateVersionView | undefined = template.versions.find((v) => v.id === versionId);

  function onStartChange(startDate: string) {
    setForm((f) => ({
      ...f,
      startDate,
      // Convenience default; the user can override.
      endDate: startDate && version ? addDays(startDate, version.nights) : f.endDate,
    }));
  }

  async function handleInstantiate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await axios.post(`/api/travel/templates/${template.id}/instantiate`, {
        templateVersionId: versionId || undefined,
        agencyId: form.agencyId,
        title: form.title,
        startDate: form.startDate,
        endDate: form.endDate,
        travelers: {
          adults: form.adults,
          children: 0,
          infants: 0,
          paying: form.paying,
          complimentary: 0,
          leaders: 0,
          staff: 0,
        },
        notes: form.notes || null,
      });
      toast(`Created ${res.data.request.packageCode} from ${template.code}`, "success");
      window.location.href = `/travel/requests/${res.data.request.id}`;
    } catch (err) {
      toast(apiError(err, "Instantiate failed"), "error");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Instantiate {template.code}</DialogTitle>
          <DialogDescription>
            Creates a new request whose v01 itinerary is copied from the template version.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleInstantiate} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Template version</Label>
              <Select value={versionId} onValueChange={setVersionId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {template.versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      v{v.versionNo} — {v.nights}n/{v.days}d{v.status !== "ACTIVE" ? ` (${v.status})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
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
            <div className="sm:col-span-2">
              <Label>Title</Label>
              <Input aria-label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div>
              <Label>Start date</Label>
              <DateField value={form.startDate} onChange={onStartChange} />
            </div>
            <div>
              <Label>End date</Label>
              <DateField value={form.endDate} onChange={(iso) => setForm({ ...form, endDate: iso })} min={form.startDate || undefined} />
            </div>
            <div>
              <Label>Adults</Label>
              <Input aria-label="Adults"
                type="number"
                min={0}
                value={form.adults}
                onChange={(e) => setForm({ ...form, adults: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0) })}
              />
            </div>
            <div>
              <Label>Paying travelers</Label>
              <Input aria-label="Paying travelers"
                type="number"
                min={0}
                value={form.paying}
                onChange={(e) => setForm({ ...form, paying: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0) })}
              />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea aria-label="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={saving || !form.agencyId || !form.startDate || !form.endDate}>
              {saving ? "Creating..." : "Create request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BatchDialog({
  template,
  quoteCurrency,
  onClose,
}: {
  template: TemplateView;
  quoteCurrency: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const activeVersion = template.versions.find((v) => v.status === "ACTIVE") ?? template.versions[0];
  const [versionId, setVersionId] = useState(activeVersion?.id ?? "");
  const [startDate, setStartDate] = useState("");
  const [bands, setBands] = useState("2,4,6");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<BatchResult[] | null>(null);

  async function handleRun(e: React.FormEvent) {
    e.preventDefault();
    const paxBands = bands
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1);
    if (paxBands.length === 0) {
      toast("Enter at least one pax band", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post("/api/travel/batch", { templateVersionId: versionId, startDate, paxBands });
      setResults(res.data.results);
    } catch (err) {
      toast(apiError(err, "Batch pricing failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Batch pricing — {template.code}</DialogTitle>
          <DialogDescription>
            Runs the engine per pax band on a synthetic full-tour stay (ceil(pax/2) DBL rooms, first active
            hotel). Results are not persisted as quotes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleRun} className="flex flex-wrap items-end gap-3">
          <div>
            <Label>Version</Label>
            <Select value={versionId} onValueChange={setVersionId}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {template.versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.versionNo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Start date</Label>
            <DateField value={startDate} onChange={setStartDate} />
          </div>
          <div>
            <Label>Pax bands</Label>
            <Input aria-label="Pax bands" value={bands} onChange={(e) => setBands(e.target.value)} placeholder="2,4,6" />
          </div>
          <Button type="submit" disabled={busy || !startDate}>
            {busy ? "Running..." : "Run"}
          </Button>
        </form>
        {results && (
          <div className="mt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Pax</TableHead>
                  <TableHead>Valid</TableHead>
                  <TableHead className="text-end">Sell</TableHead>
                  <TableHead className="text-end">Per person</TableHead>
                  <TableHead>Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r) => (
                  <TableRow key={r.pax}>
                    <TableCell>{r.pax}</TableCell>
                    <TableCell>
                      <StateBadge value={r.valid ? "READY" : "FAILED"} />
                    </TableCell>
                    <TableCell className="text-end">{r.sell ? money(r.sell, quoteCurrency) : "—"}</TableCell>
                    <TableCell className="text-end">{r.perPayingPerson ? money(r.perPayingPerson, quoteCurrency) : "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.issues.map((i, j) => (
                        <div key={j}>
                          <span className="font-mono">{i.code}</span> {i.message}
                        </div>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
