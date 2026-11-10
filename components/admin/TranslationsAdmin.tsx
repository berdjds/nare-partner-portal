"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";

interface Item { entity: string; entityId: string; field: string; label: string; english: string; state: "missing" | "draft" | "approved" | "stale"; hasAiDraft: boolean }
interface Version { id: string; version: number; status: string; source: string; model: string | null; text: string; createdAt: string; approvedAt: string | null; events: Array<{ id: string; action: string; createdAt: string }> }
const STATE_TEXT: Record<Item["state"], string> = { missing: "Missing", draft: "Draft waiting for approval", approved: "Approved", stale: "Approved, English changed: review" };
const LOCALE = "hy";
const msg = (e: unknown, fallback: string) => (axios.isAxiosError(e) ? e.response?.data?.error ?? fallback : fallback);

export default function TranslationsAdmin({ canTranslate, canApprove }: { canTranslate: boolean; canApprove: boolean }) {
  const { toast } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [filter, setFilter] = useState<"all" | Item["state"]>("all");
  const [sel, setSel] = useState<Item | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = useRef(false); // true once the person types: a late history response must never overwrite their text
  const openSeq = useRef(0);

  const loadOverview = useCallback(async () => {
    try { const r = await axios.get(`/api/admin/translations?locale=${LOCALE}`); setItems(r.data.items); setAiAvailable(r.data.aiAvailable); }
    catch (e) { toast(msg(e, "Failed to load translations"), "error"); }
  }, [toast]);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  async function open(item: Item) {
    setSel(item);
    typed.current = false;
    const seq = ++openSeq.current;
    setText("");
    try {
      const r = await axios.get(`/api/admin/translations?locale=${LOCALE}&entity=${item.entity}&entityId=${encodeURIComponent(item.entityId)}&field=${encodeURIComponent(item.field)}`);
      if (seq !== openSeq.current) return; // another item was opened meanwhile
      const v: Version[] = r.data.history; setVersions(v);
      const draft = v.find((x) => x.status === "DRAFT") ?? v.find((x) => x.status === "APPROVED");
      if (!typed.current) setText(draft?.text ?? "");
    } catch (e) { toast(msg(e, "Failed to load this item"), "error"); }
  }
  const act = async (body: Record<string, unknown>, ok: string) => {
    if (!sel) return; setBusy(true);
    try { await axios.post("/api/admin/translations", { entity: sel.entity, entityId: sel.entityId, field: sel.field, locale: LOCALE, ...body }); toast(ok, "success"); await open(sel); await loadOverview(); }
    catch (e) { toast(msg(e, "Action failed"), "error"); } finally { setBusy(false); }
  };
  const draft = versions.find((v) => v.status === "DRAFT");
  const shown = items.filter((i) => filter === "all" || i.state === filter);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Armenian (հայերեն)</CardTitle>
          <CardDescription>{items.filter((i) => i.state === "missing").length} missing of {items.length}</CardDescription>
          <div className="pt-2"><Label htmlFor="tr-filter">Show</Label>
            <select id="tr-filter" className="mt-1 h-11 w-full rounded-lg border bg-card px-2 text-sm sm:h-9" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All items</option><option value="missing">Missing</option><option value="draft">Drafts</option><option value="stale">Needs review</option><option value="approved">Approved</option>
            </select></div>
        </CardHeader>
        <CardContent>
          {shown.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to show.</p> : (
            <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
              {shown.map((i) => (
                <li key={`${i.entity}|${i.entityId}|${i.field}`}>
                  <button type="button" onClick={() => open(i)} aria-current={sel && sel.entityId === i.entityId && sel.field === i.field ? "true" : undefined}
                    className="flex min-h-11 w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted">
                    <span className="font-medium">{i.label}</span>
                    <span className="text-xs text-muted-foreground">{STATE_TEXT[i.state]}{i.hasAiDraft ? " · AI draft" : ""}</span>
                  </button>
                </li>))}
            </ul>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{sel ? sel.label : "Select an item"}</CardTitle><CardDescription>{sel ? "Source on the left, translation on the right." : "Pick an item from the list to translate it."}</CardDescription></CardHeader>
        {sel && (
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div><p className="mb-1 text-sm font-medium">English (source)</p><p lang="en" className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm">{sel.english}</p></div>
              <div><Label htmlFor="tr-text">Armenian</Label>
                <Textarea id="tr-text" lang="hy" rows={6} value={text} onChange={(e) => { typed.current = true; setText(e.target.value); }} disabled={!canTranslate} /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canTranslate && <Button type="button" disabled={busy || !text.trim()} onClick={() => act({ action: "draft", text }, "Draft saved")}>Save draft</Button>}
              {canTranslate && <Button type="button" variant="outline" disabled={busy || !aiAvailable} onClick={() => { if (window.confirm(`This exact English text will be sent to the AI provider:\n\n${sel.english}\n\nMake sure it contains no client names or contact, booking, price or cost details. Continue?`)) act({ action: "ai" }, "AI draft created, review it before approving"); }}>Generate AI draft</Button>}
              {canApprove && draft && <Button type="button" variant="outline" disabled={busy} onClick={() => { const replacesHuman = draft.source === "AI" && versions.some((v) => v.status === "APPROVED" && v.source === "HUMAN"); if (replacesHuman && !window.confirm("This AI draft will replace the approved human translation (kept in history). Approve it anyway?")) return; act({ action: "approve", id: draft.id }, "Approved and published"); }}>Approve draft v{draft.version}</Button>}
              {canApprove && draft && <Button type="button" variant="ghost" disabled={busy} onClick={() => act({ action: "reject", id: draft.id }, "Draft rejected")}>Reject draft</Button>}
            </div>
            {canTranslate && !aiAvailable && <p className="text-xs text-muted-foreground">AI generation is switched off on this server. Drafts can still be written by hand.</p>}
            {draft?.source === "AI" && <p role="status" className="text-sm font-medium">This draft was written by AI ({draft.model}). Read and edit it, then save a draft before approving if you changed anything.</p>}
            <div>
              <h3 className="mb-1 text-sm font-medium">History</h3>
              {versions.length === 0 ? <p className="text-sm text-muted-foreground">No versions yet.</p> : (
                <ol className="space-y-1 text-sm">
                  {versions.map((v) => (<li key={v.id} className="rounded-md border p-2"><span className="font-medium">v{v.version} · {v.status.toLowerCase()}</span> · {v.source === "AI" ? `AI (${v.model})` : "human"} · {new Date(v.createdAt).toLocaleString()}{v.approvedAt ? ` · approved ${new Date(v.approvedAt).toLocaleString()}` : ""}</li>))}
                </ol>)}
            </div>
          </CardContent>)}
      </Card>
    </div>
  );
}
