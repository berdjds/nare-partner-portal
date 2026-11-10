"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Inbox, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { QUOTE_STATUSES } from "@/lib/travel/contracts";
import { formatDisplayDateRange } from "@/lib/travel/engine/dates";
import { PageHeader } from "./TravelShell";
import { StatusBadge, apiError } from "./utils";
import type { RequestListItem } from "./types";

interface RequestsListProps {
  role: string;
  userId: string;
  permissions: string[];
}

export default function RequestsList({ role, userId, permissions }: RequestsListProps) {
  const { toast } = useToast();
  const [requests, setRequests] = useState<RequestListItem[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("ALL");
  const [onlyMine, setOnlyMine] = useState(false);
  const [deleteFor, setDeleteFor] = useState<RequestListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // W2: the New request page also requires the travel.create permission the
  // server enforces on POST /api/travel/requests.
  const canCreate = (role === "ADMIN" || role === "ADVISOR") && permissions.includes("travel.create");
  const isAdmin = role === "ADMIN";
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
            <Button asChild>
              <Link href="/travel/requests/new"><Plus /> New request</Link>
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
              <Button variant="outline" size="sm" asChild>
                <Link href="/travel/requests/new"><Plus /> Create your first request</Link>
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
