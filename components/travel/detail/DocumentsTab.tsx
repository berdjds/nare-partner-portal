"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { versionLabel } from "@/lib/travel/contracts";
import { StateBadge, apiError, formatDateTime, shortHash } from "../utils";
import type { DocumentDetail, TravelUser } from "../types";
import type { DetailContext } from "./RequestDetail";

type DocRow = DocumentDetail & { versionNo: number; versionId: string };

export default function DocumentsTab({ ctx }: { ctx: DetailContext }) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendDoc, setSendDoc] = useState<DocRow | null>(null);

  const docs: DocRow[] = ctx.detail.versions
    .flatMap((v) => v.documents.map((d) => ({ ...d, versionNo: v.versionNo, versionId: v.id })))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  async function handleRetry(versionId: string, documentId: string) {
    setBusyId(documentId);
    try {
      await axios.post(`/api/travel/versions/${versionId}/issue`, { retryDocumentId: documentId });
      toast("Document regenerated", "success");
      ctx.refresh();
    } catch (err) {
      toast(apiError(err, "Retry failed"), "error");
    } finally {
      setBusyId(null);
    }
  }

  const canRetry = ctx.isAdmin;
  const canSend = ctx.isAdmin || ctx.isOwner || ctx.detail.currentValidatorId === ctx.userId;

  // W2: mirror the per-kind document permissions the server enforces —
  // downloads and client-document sends hide when the key is missing.
  const canDownload = (d: DocumentDetail) =>
    d.kind === "INTERNAL"
      ? ctx.permissions.includes("travel.internal.download")
      : ctx.permissions.includes("travel.client_docs.download");
  const canSendDoc = (d: DocumentDetail) =>
    canSend && (d.kind !== "CLIENT" || ctx.permissions.includes("travel.client_docs.send"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <CardDescription>Generated documents for this request. The list is filtered to your role.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-3">Version</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Issued at</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead className="pr-3">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {docs.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="pl-3">{versionLabel(d.versionNo)}</TableCell>
                  <TableCell>{d.kind}</TableCell>
                  <TableCell>
                    <StateBadge value={d.renderState} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(d.issuedAt)}</TableCell>
                  <TableCell className="font-mono text-xs">{shortHash(d.sha256)}</TableCell>
                  <TableCell className="pr-3">
                    <div className="flex gap-2">
                      {d.renderState === "READY" && canDownload(d) && (
                        <a href={`/api/travel/documents/${d.id}`} target="_blank" rel="noreferrer">
                          <Button size="sm" variant="outline">
                            Download
                          </Button>
                        </a>
                      )}
                      {d.renderState === "READY" && canSendDoc(d) && (
                        <Button size="sm" variant="outline" onClick={() => setSendDoc(d)}>
                          Send via WhatsApp
                        </Button>
                      )}
                      {d.renderState === "FAILED" && canRetry && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === d.id}
                          onClick={() => handleRetry(d.versionId, d.id)}
                        >
                          {busyId === d.id ? "Retrying..." : "Retry render"}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {docs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No documents yet — issue an approved version to generate the client PDF.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      {sendDoc && <SendDocumentDialog doc={sendDoc} onClose={() => setSendDoc(null)} />}
    </Card>
  );
}

// ---------------------------------------------------------------------------

interface GroupChat {
  remoteJid: string;
  name: string | null;
}

/**
 * WhatsApp delivery picker: active users that have a phone on file, plus the
 * WhatsApp groups the linked account is in (from the dashboard chat list).
 * The server reports per-recipient success/failure.
 */
function SendDocumentDialog({ doc, onClose }: { doc: DocRow; onClose: () => void }) {
  const { toast } = useToast();
  const [users, setUsers] = useState<TravelUser[]>([]);
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    axios
      .get("/api/travel/users/assignable")
      .then((res) => setUsers((res.data as TravelUser[]).filter((u) => u.phone)))
      .catch(() => setUsers([]));
    axios
      .get("/api/chats")
      .then((res) =>
        setGroups(
          (res.data as GroupChat[])
            .filter((c) => c.remoteJid.endsWith("@g.us"))
            .map((c) => ({ remoteJid: c.remoteJid, name: c.name })),
        ),
      )
      .catch(() => setGroups([]));
  }, []);

  function toggle(set: Set<string>, value: string, apply: (next: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    apply(next);
  }

  async function handleSend() {
    setBusy(true);
    try {
      const res = await axios.post(`/api/travel/documents/${doc.id}/send`, {
        userIds: Array.from(selectedUsers),
        groupJids: Array.from(selectedGroups),
      });
      const results: { to: string; ok: boolean; error?: string }[] = res.data.results ?? [];
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast(`Sent to ${results.length} recipient${results.length === 1 ? "" : "s"}`, "success");
        onClose();
      } else {
        toast(
          `Failed for ${failed.map((r) => `${r.to} (${r.error})`).join(", ")}`,
          "error",
        );
      }
    } catch (err) {
      toast(apiError(err, "Send failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  const selectedCount = selectedUsers.size + selectedGroups.size;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Send {versionLabel(doc.versionNo)} {doc.kind} PDF via WhatsApp
          </DialogTitle>
          <DialogDescription>
            {doc.kind === "INTERNAL"
              ? "Internal documents carry margins — delivery is restricted to validators and admins."
              : "Pick recipients; each delivery is reported individually."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-4 overflow-auto">
          <div>
            <Label>Users with a WhatsApp phone</Label>
            {users.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">No users have a phone number on file.</p>
            )}
            <div className="mt-1 space-y-1">
              {users.map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedUsers.has(u.id)}
                    onChange={() => toggle(selectedUsers, u.id, setSelectedUsers)}
                  />
                  {u.name || u.email} ({u.role ?? "USER"}, +{u.phone})
                </label>
              ))}
            </div>
          </div>
          <div>
            <Label>WhatsApp groups</Label>
            {groups.length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No groups in the chat list — a group appears after WhatsApp syncs it.
              </p>
            )}
            <div className="mt-1 space-y-1">
              {groups.map((g) => (
                <label key={g.remoteJid} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedGroups.has(g.remoteJid)}
                    onChange={() => toggle(selectedGroups, g.remoteJid, setSelectedGroups)}
                  />
                  {g.name || g.remoteJid}
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSend} disabled={busy || selectedCount === 0}>
            {busy ? "Sending..." : `Send to ${selectedCount} recipient${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
