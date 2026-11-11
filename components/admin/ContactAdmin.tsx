"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { mapEmbedUrl, SOCIAL_PLATFORMS, type ContactData } from "@/lib/contact/schema";

type Scope = "global" | "portal";
interface Row { id: string; scope: string; version: number; status: string; dataJson: string; note: string | null; createdAt: string; publishedAt: string | null; publishedById: string | null }
const VIS_LABELS: Record<string, string> = { foundedYear: "Founded year", generalEmail: "General email", b2bEmail: "B2B portal email", phones: "Phones", whatsapp: "WhatsApp", address: "Address", hours: "Business hours", map: "Map", social: "Social links" };
const GROUPS = ["emails", "phones", "details", "social", "map", "visibility"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_KEYS: Record<Group, string[]> = { emails: ["generalEmail", "b2bEmail"], phones: ["phones", "whatsapp"], details: ["foundedYear", "address", "hours"], social: ["social"], map: ["map"], visibility: ["visibility"] };
const GROUP_LABEL: Record<Group, string> = { emails: "Emails", phones: "Phones and WhatsApp", details: "Founded year, address and hours", social: "Social links", map: "Map", visibility: "What is shown publicly" };
const msg = (e: unknown, fb: string) => (axios.isAxiosError(e) ? e.response?.data?.error ?? fb : fb);
const parse = (j: string): Partial<ContactData> => { try { return JSON.parse(j); } catch { return {}; } };

export default function ContactAdmin() {
  const { toast } = useToast();
  const [scope, setScope] = useState<Scope>("global");
  const [rows, setRows] = useState<Row[]>([]);
  const [defaults, setDefaults] = useState<ContactData | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [override, setOverride] = useState<Record<Group, boolean>>({ emails: true, phones: true, details: true, social: true, map: true, visibility: true });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (s: Scope) => {
    try {
      const r = await axios.get(`/api/admin/contact?scope=${s}`);
      setRows(r.data.history); setDefaults(r.data.defaults);
      const latest: Row | undefined = r.data.history.find((x: Row) => x.status === "DRAFT") ?? r.data.history.find((x: Row) => x.status === "PUBLISHED");
      const data = latest ? parse(latest.dataJson) : s === "global" ? r.data.defaults : {};
      const base = s === "global" ? (latest ? data : r.data.defaults) : data; // a saved profile is shown exactly as saved: cleared fields stay cleared
      setForm({
        foundedYear: base.foundedYear ?? "", generalEmail: base.generalEmail ?? "", b2bEmail: base.b2bEmail ?? "",
        phones: (base.phones ?? []).map((p: { number: string }) => p.number).join("\n"), whatsapp: base.whatsapp ?? "",
        address: base.address ?? "", hours: base.hours ?? "",
        ...Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [`social_${p}`, base.social?.[p] ?? ""])),
        mapUrl: base.map?.url ?? "", placeId: base.map?.placeId ?? "", lat: base.map?.lat ?? "", lng: base.map?.lng ?? "",
        visibility: { ...(s === "global" ? r.data.defaults.visibility : {}), ...(base.visibility ?? {}) },
      });
      setOverride(s === "global" ? { emails: true, phones: true, details: true, social: true, map: true, visibility: true }
        : { emails: "generalEmail" in data || "b2bEmail" in data, phones: "phones" in data || "whatsapp" in data, details: "address" in data || "hours" in data || "foundedYear" in data, social: "social" in data, map: "map" in data, visibility: "visibility" in data });
    } catch (e) { toast(msg(e, "Failed to load"), "error"); }
  }, [toast]);
  useEffect(() => { load(scope); }, [scope, load]);

  const num = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : Number(v));
  function payload() {
    const on = (g: Group) => scope === "global" || override[g];
    const d: Record<string, unknown> = {};
    if (on("emails")) { d.generalEmail = form.generalEmail; d.b2bEmail = form.b2bEmail; }
    if (on("phones")) { d.phones = String(form.phones).split("\n").map((s) => s.trim()).filter(Boolean).map((number) => ({ number })); if (form.whatsapp) d.whatsapp = form.whatsapp; }
    if (on("details")) { if (form.foundedYear !== "") d.foundedYear = num(form.foundedYear); if (form.address) d.address = form.address; if (form.hours) d.hours = form.hours; }
    if (on("social")) { const so = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p, String(form[`social_${p}`] ?? "").trim()]).filter(([, u]) => u)); d.social = so; }
    if (on("map")) { const m: Record<string, unknown> = {}; if (form.mapUrl) m.url = form.mapUrl; if (form.placeId) m.placeId = form.placeId; if (form.lat !== "") m.lat = num(form.lat); if (form.lng !== "") m.lng = num(form.lng); if (Object.keys(m).length) d.map = m; }
    if (on("visibility")) d.visibility = form.visibility;
    return d;
  }
  async function save() {
    setBusy(true); setError("");
    try { await axios.put("/api/admin/contact", { scope, data: payload(), note }); toast("Draft saved. It is not public until you publish it.", "success"); setNote(""); await load(scope); }
    catch (e) { const m = msg(e, "Could not save"); setError(m); toast("Check the highlighted problems", "error"); } finally { setBusy(false); }
  }
  async function publish(id: string) {
    setBusy(true);
    try { await axios.post("/api/admin/contact/publish", { id }); toast("Published", "success"); await load(scope); } catch (e) { toast(msg(e, "Could not publish"), "error"); } finally { setBusy(false); }
  }
  const draft = rows.find((r) => r.status === "DRAFT");
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const latN = form.lat === "" || form.lat === undefined ? NaN : Number(form.lat);
  const lngN = form.lng === "" || form.lng === undefined ? NaN : Number(form.lng);
  const preview = Number.isFinite(latN) && Number.isFinite(lngN) && Math.abs(latN) <= 90 && Math.abs(lngN) <= 180 ? mapEmbedUrl({ lat: latN, lng: lngN }) : null;
  const grp = (g: Group, children: React.ReactNode) => (
    <fieldset className="rounded-lg border p-4"><legend className="px-1 text-sm font-semibold">{GROUP_LABEL[g]}</legend>
      {scope === "portal" && <label className="mb-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={override[g]} onChange={(e) => setOverride((o) => ({ ...o, [g]: e.target.checked }))} /> Override the global value (otherwise inherited)</label>}
      <div className={`space-y-3 ${scope === "portal" && !override[g] ? "pointer-events-none opacity-60" : ""}`} aria-disabled={scope === "portal" && !override[g]}>{children}</div>
    </fieldset>);
  const field = (id: string, label: string, el: React.ReactNode) => <div><Label htmlFor={id}>{label}</Label>{el}</div>;

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
          <CardDescription>Saving creates a draft. Only publishing changes what visitors see.</CardDescription>
          <div role="group" aria-label="Scope" className="flex gap-2 pt-2">
            {(["global", "portal"] as Scope[]).map((s) => <Button key={s} type="button" size="sm" variant={scope === s ? "default" : "outline"} aria-pressed={scope === s} onClick={() => setScope(s)}>{s === "global" ? "Global defaults" : "Portal override"}</Button>)}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</p>}
          {grp("emails", <div className="grid gap-3 sm:grid-cols-2">
            {field("ct-general", "General email", <Input id="ct-general" type="email" value={form.generalEmail ?? ""} onChange={(e) => set("generalEmail", e.target.value)} />)}
            {field("ct-b2b", "B2B portal email", <Input id="ct-b2b" type="email" value={form.b2bEmail ?? ""} onChange={(e) => set("b2bEmail", e.target.value)} />)}
          </div>)}
          {grp("phones", <div className="grid gap-3 sm:grid-cols-2">
            {field("ct-phones", "Phones (one per line)", <Textarea id="ct-phones" rows={3} value={form.phones ?? ""} onChange={(e) => set("phones", e.target.value)} />)}
            {field("ct-wa", "WhatsApp (digits, optional +)", <Input id="ct-wa" value={form.whatsapp ?? ""} onChange={(e) => set("whatsapp", e.target.value)} />)}
          </div>)}
          {grp("details", <div className="grid gap-3 sm:grid-cols-2">
            {field("ct-year", "Founded year", <Input id="ct-year" type="number" value={form.foundedYear ?? ""} onChange={(e) => set("foundedYear", e.target.value)} />)}
            {field("ct-hours", "Business hours", <Input id="ct-hours" value={form.hours ?? ""} onChange={(e) => set("hours", e.target.value)} />)}
            <div className="sm:col-span-2">{field("ct-address", "Address", <Textarea id="ct-address" rows={2} value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} />)}</div>
          </div>)}
          {grp("social", <div className="grid gap-3 sm:grid-cols-2">
            {SOCIAL_PLATFORMS.map((p) => field(`ct-social-${p}`, `${p[0].toUpperCase()}${p.slice(1)} link`, <Input id={`ct-social-${p}`} value={form[`social_${p}`] ?? ""} onChange={(e) => set(`social_${p}`, e.target.value)} placeholder="https://" />))}
            <p className="text-xs text-muted-foreground sm:col-span-2">Only https links on the platform's own domain are accepted. Leave a field empty to hide that icon.</p>
          </div>)}
          {grp("map", <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">{field("ct-mapurl", "Google Maps link", <Input id="ct-mapurl" value={form.mapUrl ?? ""} onChange={(e) => set("mapUrl", e.target.value)} placeholder="https://maps.app.goo.gl/..." />)}</div>
            {field("ct-place", "Place ID", <Input id="ct-place" value={form.placeId ?? ""} onChange={(e) => set("placeId", e.target.value)} />)}
            <div className="grid grid-cols-2 gap-3">{field("ct-lat", "Latitude", <Input id="ct-lat" inputMode="decimal" value={form.lat ?? ""} onChange={(e) => set("lat", e.target.value)} />)}{field("ct-lng", "Longitude", <Input id="ct-lng" inputMode="decimal" value={form.lng ?? ""} onChange={(e) => set("lng", e.target.value)} />)}</div>
            <p className="text-xs text-muted-foreground sm:col-span-2">No map key is used or stored. The preview and the public embed are built from the coordinates; the link and Place ID open Google Maps in a new tab.</p>
            {preview && <iframe title="Map preview" src={preview} className="h-56 w-full rounded-lg border sm:col-span-2" loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" />}
          </div>)}
          {grp("visibility", <div className="grid gap-1 sm:grid-cols-2">
            {Object.entries(VIS_LABELS).map(([k, l]) => <label key={k} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={Boolean(form.visibility?.[k])} onChange={(e) => set("visibility", { ...form.visibility, [k]: e.target.checked })} /> {l}</label>)}
          </div>)}
          <div>{field("ct-note", "What changed (optional)", <Input id="ct-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />)}</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={save} disabled={busy}>Save draft</Button>
            <Button type="button" variant="outline" onClick={() => draft && publish(draft.id)} disabled={busy || !draft}>Publish draft v{draft?.version ?? "–"}</Button>
          </div>
          {defaults && scope === "global" && <p className="text-xs text-muted-foreground">Until something is published, visitors see the built-in approved details (founded {defaults.foundedYear}, {defaults.generalEmail}, {defaults.b2bEmail}).</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>History</CardTitle><CardDescription>{scope === "global" ? "Global defaults" : "Portal override"}</CardDescription></CardHeader>
        <CardContent>
          {rows.length === 0 ? <p className="text-sm text-muted-foreground">No versions yet.</p> : (
            <ol className="space-y-2 text-sm">{rows.map((r) => <li key={r.id} className="rounded-md border p-2"><p className="font-medium">v{r.version} · {r.status.toLowerCase()}</p><p className="text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}{r.publishedAt ? ` · published ${new Date(r.publishedAt).toLocaleString()}` : ""}</p>{r.note && <p className="text-xs">{r.note}</p>}</li>)}</ol>)}
        </CardContent>
      </Card>
    </div>
  );
}
