"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  PERMISSION_KEYS,
  INTERNAL_PERMISSION_KEYS,
  effectivePermissions,
  type PermissionKey,
} from "@/lib/permissions";

interface PermissionsUser {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  overrides: { key: string; allowed: boolean }[];
  preset: string[];
  effective: string[];
}

interface PermissionsResponse {
  keys: string[];
  internalLocked: boolean;
  users: PermissionsUser[];
}

// "default" = no UserPermission row, the role preset applies.
type OverrideChoice = "default" | "grant" | "deny";

function choiceFor(overrides: { key: string; allowed: boolean }[], key: string): OverrideChoice {
  const row = overrides.find((o) => o.key === key);
  if (!row) return "default";
  return row.allowed ? "grant" : "deny";
}

export default function UserPermissionsDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<PermissionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<Record<string, OverrideChoice>>({});

  const user = data?.users.find((u) => u.id === userId) ?? null;

  useEffect(() => {
    if (!userId) return;
    setLoading(true);
    setData(null);
    axios
      .get("/api/permissions")
      .then((res) => {
        const response = res.data as PermissionsResponse;
        setData(response);
        const target = response.users.find((u) => u.id === userId);
        if (target) {
          const initial: Record<string, OverrideChoice> = {};
          for (const key of PERMISSION_KEYS) initial[key] = choiceFor(target.overrides, key);
          setPending(initial);
        }
      })
      .catch((err) => {
        toast(err?.response?.data?.error || "Failed to load permissions", "error");
        onClose();
      })
      .finally(() => setLoading(false));
  }, [userId]);

  // Live preview: effective = (role preset ∪ grants) − denies, exactly as the
  // server resolves it, so the admin sees the result before saving.
  const effective = useMemo(
    () =>
      user
        ? effectivePermissions(
            user.role,
            PERMISSION_KEYS.filter((key) => pending[key] && pending[key] !== "default").map((key) => ({
              key,
              allowed: pending[key] === "grant",
            })),
          )
        : new Set<PermissionKey>(),
    [user, pending],
  );

  // D2/D3: while the proposed-permissions report is unconfirmed, internal-cost
  // keys stay admin-only and the server rejects granting them to ANY user —
  // an ADMIN target included, because an orphan grant row would survive a
  // later demotion.
  const internalLocked = data?.internalLocked ?? false;

  async function handleSave() {
    if (!user) return;
    const changed = PERMISSION_KEYS.filter((key) => pending[key] !== choiceFor(user.overrides, key)).map((key) => ({
      key,
      allowed: pending[key] === "grant" ? true : pending[key] === "deny" ? false : null,
    }));
    if (changed.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await axios.put("/api/permissions", { userId: user.id, overrides: changed });
      toast("Permissions updated", "success");
      onClose();
    } catch (err: any) {
      // Surface the server message verbatim: it distinguishes self-change,
      // last-admin and internal-locked rejections.
      toast(err?.response?.data?.error || "Failed to update permissions", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={userId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Permissions</DialogTitle>
          <DialogDescription>
            {user ? `Per-user overrides for ${user.name} (${user.email}). "Default" follows the ${user.role} role preset.` : "Loading…"}
          </DialogDescription>
        </DialogHeader>
        {loading || !user ? (
          <p className="py-6 text-sm text-muted-foreground">Loading permissions…</p>
        ) : (
          <div className="space-y-1">
            {internalLocked && (
              <p className="mb-3 text-xs text-muted-foreground">
                Internal-cost permissions stay admin-only until the proposed-permissions report is confirmed.
              </p>
            )}
            {PERMISSION_KEYS.map((key) => {
              const presetOn = user.preset.includes(key);
              const grantDisabled = internalLocked && INTERNAL_PERMISSION_KEYS.has(key);
              return (
                <div key={key} className="flex items-center gap-3 border-b py-2 last:border-0">
                  <code className="flex-1 font-mono text-xs">{key}</code>
                  <Badge variant="outline">{presetOn ? "On" : "Off"}</Badge>
                  <Select
                    value={pending[key] ?? "default"}
                    onValueChange={(v) => setPending((prev) => ({ ...prev, [key]: v as OverrideChoice }))}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="grant" disabled={grantDisabled}>
                        Grant
                      </SelectItem>
                      <SelectItem value="deny">Deny</SelectItem>
                    </SelectContent>
                  </Select>
                  <Badge variant={effective.has(key) ? "default" : "destructive"} className="w-20 justify-center">
                    {effective.has(key) ? "Allowed" : "Denied"}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading || !user || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
