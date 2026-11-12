"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "./TravelShell";
import { apiError, formatDateTime } from "./utils";
import type { Agency } from "./types";

interface AgenciesAdminProps {
  role: string;
}

const EMPTY_FORM = { shortCode: "", name: "", contactName: "", contactEmail: "", contactPhone: "" };

export default function AgenciesAdmin({ role }: AgenciesAdminProps) {
  const { toast } = useToast();
  const [agencies, setAgencies] = useState<Agency[] | null>(null);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Agency | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_FORM);
  const [savingEdit, setSavingEdit] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(() => {
    axios
      .get("/api/travel/agencies", { params: { includeInactive: true } })
      .then((res) => setAgencies(res.data))
      .catch((err) => toast(apiError(err, "Failed to load agencies"), "error"));
  }, [toast]);

  useEffect(load, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await axios.post("/api/travel/agencies", {
        shortCode: createForm.shortCode.trim().toUpperCase(),
        name: createForm.name.trim(),
        contactName: createForm.contactName.trim() || null,
        contactEmail: createForm.contactEmail.trim() || null,
        contactPhone: createForm.contactPhone.trim() || null,
      });
      toast("Agency created", "success");
      setCreateForm(EMPTY_FORM);
      load();
    } catch (err) {
      toast(apiError(err, "Failed to create agency"), "error");
    } finally {
      setCreating(false);
    }
  }

  function openEdit(agency: Agency) {
    setEditing(agency);
    setEditForm({
      shortCode: agency.shortCode,
      name: agency.name,
      contactName: agency.contactName ?? "",
      contactEmail: agency.contactEmail ?? "",
      contactPhone: agency.contactPhone ?? "",
    });
  }

  async function handleEditSave(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setSavingEdit(true);
    try {
      await axios.patch(`/api/travel/agencies/${editing.id}`, {
        shortCode: editForm.shortCode.trim().toUpperCase(),
        name: editForm.name.trim(),
        contactName: editForm.contactName.trim() || null,
        contactEmail: editForm.contactEmail.trim() || null,
        contactPhone: editForm.contactPhone.trim() || null,
      });
      toast("Agency updated", "success");
      setEditing(null);
      load();
    } catch (err) {
      toast(apiError(err, "Failed to update agency"), "error");
    } finally {
      setSavingEdit(false);
    }
  }

  async function toggleActive(agency: Agency) {
    setTogglingId(agency.id);
    try {
      await axios.patch(`/api/travel/agencies/${agency.id}`, { active: !agency.active });
      toast(agency.active ? "Agency deactivated" : "Agency reactivated", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to update agency"), "error");
    } finally {
      setTogglingId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Agencies"
        subtitle="Client agencies. The short code is embedded in package codes (ACME-2026-09-21-0001) — choose a stable one."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>All agencies</CardTitle>
            <CardDescription>Deactivated agencies stay on record but disappear from advisor pickers.</CardDescription>
          </CardHeader>
          <CardContent>
            {agencies === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : agencies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agencies yet — create the first one on the right.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agencies.map((agency) => (
                    <TableRow key={agency.id}>
                      <TableCell className="font-mono font-medium">{agency.shortCode}</TableCell>
                      <TableCell>{agency.name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {agency.contactName && <div>{agency.contactName}</div>}
                        {agency.contactEmail && <div>{agency.contactEmail}</div>}
                        {agency.contactPhone && <div>{agency.contactPhone}</div>}
                        {!agency.contactName && !agency.contactEmail && !agency.contactPhone && "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={agency.active ? "success" : "neutral"}>
                          {agency.active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="outline" size="sm" onClick={() => openEdit(agency)}>
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={togglingId === agency.id}
                            onClick={() => toggleActive(agency)}
                          >
                            {agency.active ? "Deactivate" : "Reactivate"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New agency</CardTitle>
            <CardDescription>Required before any request can be created for that client.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <Label>Short code</Label>
                <Input aria-label="Short code"
                  value={createForm.shortCode}
                  onChange={(e) => setCreateForm({ ...createForm, shortCode: e.target.value.toUpperCase() })}
                  placeholder="ACME"
                  maxLength={12}
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">2–12 uppercase letters/digits, unique.</p>
              </div>
              <div>
                <Label>Name</Label>
                <Input aria-label="Name"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="Acme Travel LLC"
                  required
                />
              </div>
              <div>
                <Label>Contact name (optional)</Label>
                <Input aria-label="Contact name (optional)"
                  value={createForm.contactName}
                  onChange={(e) => setCreateForm({ ...createForm, contactName: e.target.value })}
                />
              </div>
              <div>
                <Label>Contact email (optional)</Label>
                <Input aria-label="Contact email (optional)"
                  type="email"
                  value={createForm.contactEmail}
                  onChange={(e) => setCreateForm({ ...createForm, contactEmail: e.target.value })}
                />
              </div>
              <div>
                <Label>Contact phone (optional)</Label>
                <Input aria-label="Contact phone (optional)"
                  value={createForm.contactPhone}
                  onChange={(e) => setCreateForm({ ...createForm, contactPhone: e.target.value })}
                />
              </div>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create agency"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit agency</DialogTitle>
            <DialogDescription>
              {editing && `Created ${formatDateTime(editing.createdAt ?? null)}. Changing the short code only affects package codes generated afterwards.`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSave} className="space-y-4">
            <div>
              <Label>Short code</Label>
              <Input aria-label="Short code"
                value={editForm.shortCode}
                onChange={(e) => setEditForm({ ...editForm, shortCode: e.target.value.toUpperCase() })}
                maxLength={12}
                required
              />
            </div>
            <div>
              <Label>Name</Label>
              <Input aria-label="Name"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                required
              />
            </div>
            <div>
              <Label>Contact name</Label>
              <Input aria-label="Contact name"
                value={editForm.contactName}
                onChange={(e) => setEditForm({ ...editForm, contactName: e.target.value })}
              />
            </div>
            <div>
              <Label>Contact email</Label>
              <Input aria-label="Contact email"
                type="email"
                value={editForm.contactEmail}
                onChange={(e) => setEditForm({ ...editForm, contactEmail: e.target.value })}
              />
            </div>
            <div>
              <Label>Contact phone</Label>
              <Input aria-label="Contact phone"
                value={editForm.contactPhone}
                onChange={(e) => setEditForm({ ...editForm, contactPhone: e.target.value })}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={savingEdit}>
                {savingEdit ? "Saving..." : "Save changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
