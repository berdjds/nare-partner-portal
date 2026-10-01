"use client";

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "./TravelShell";
import { apiError, formatDateTime } from "./utils";
import type { PolicyView, TravelSettingsView, TravelUser } from "./types";

interface SettingsPanelProps {
  role: string;
  userId: string;
}

/** Policy rate/fee fractions are stored as decimals (0.16) — display as percents (16%). */
function formatFractionPercent(value: string | null): string {
  if (value == null || value === "") return "—";
  const pct = Number(value) * 100;
  if (!Number.isFinite(pct)) return value;
  // toFixed-then-Number trims both float noise (0.16 → 16.000…004) and trailing zeros.
  return `${Number(pct.toFixed(4))}%`;
}

export default function SettingsPanel({ role, userId }: SettingsPanelProps) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<TravelSettingsView | null>(null);
  const [activePolicy, setActivePolicy] = useState<PolicyView | null>(null);
  const [form, setForm] = useState({ companyTz: "", overdueReminderHours: "", requireSettingsForIssue: true, infantMaxAge: "2" });
  const [validatorIds, setValidatorIds] = useState<string[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<TravelUser[]>([]);
  // W3 (travel-nare): the WhatsApp account all travel sends go through.
  const [accountKey, setAccountKey] = useState("");
  const [waAccounts, setWaAccounts] = useState<
    Array<{ key: string; displayName: string; enabled: boolean; purpose: string }>
  >([]);
  const [branding, setBranding] = useState({
    companyName: "",
    companyPhone: "",
    companyEmail: "",
    companyAddress: "",
    companyWebsite: "",
    brandColor: "",
  });
  const [saving, setSaving] = useState(false);
  const [savingBranding, setSavingBranding] = useState(false);

  const load = useCallback(() => {
    axios
      .get("/api/travel/settings")
      .then((res) => {
        setSettings(res.data.settings);
        setActivePolicy(res.data.activePolicy ?? null);
        setForm({
          companyTz: res.data.settings.companyTz,
          overdueReminderHours:
            res.data.settings.overdueReminderHours == null ? "" : String(res.data.settings.overdueReminderHours),
          requireSettingsForIssue: res.data.settings.requireSettingsForIssue,
          infantMaxAge: String(res.data.settings.infantMaxAge ?? 2),
        });
        try {
          setValidatorIds(JSON.parse(res.data.settings.validatorUserIds ?? "[]"));
        } catch {
          setValidatorIds([]);
        }
        setAccountKey(res.data.settings.whatsappAccountKey ?? "nare");
        setBranding({
          companyName: res.data.settings.companyName ?? "",
          companyPhone: res.data.settings.companyPhone ?? "",
          companyEmail: res.data.settings.companyEmail ?? "",
          companyAddress: res.data.settings.companyAddress ?? "",
          companyWebsite: res.data.settings.companyWebsite ?? "",
          brandColor: res.data.settings.brandColor ?? "",
        });
      })
      .catch((err) => toast(apiError(err, "Failed to load settings"), "error"));
    axios
      .get("/api/travel/users/assignable")
      .then((res) => setAssignableUsers(res.data as TravelUser[]))
      .catch(() => setAssignableUsers([]));
    // Account list for the travel-account picker (ADMIN-only page; if the
    // call fails the picker falls back to a plain input with the saved key).
    axios
      .get("/api/whatsapp/accounts")
      .then((res) => setWaAccounts(res.data as Array<{ key: string; displayName: string; enabled: boolean; purpose: string }>))
      .catch(() => setWaAccounts([]));
  }, [toast]);

  useEffect(load, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await axios.put("/api/travel/settings", {
        companyTz: form.companyTz,
        overdueReminderHours: form.overdueReminderHours === "" ? null : Number.parseInt(form.overdueReminderHours, 10),
        requireSettingsForIssue: form.requireSettingsForIssue,
        infantMaxAge: Number.parseInt(form.infantMaxAge || "2", 10),
        validatorUserIds: validatorIds,
        whatsappAccountKey: accountKey || undefined,
      });
      toast("Settings saved", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to save settings"), "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveBranding(e: React.FormEvent) {
    e.preventDefault();
    setSavingBranding(true);
    try {
      const blankToNull = (v: string) => (v.trim() === "" ? null : v.trim());
      await axios.put("/api/travel/settings", {
        companyName: blankToNull(branding.companyName),
        companyPhone: blankToNull(branding.companyPhone),
        companyEmail: blankToNull(branding.companyEmail),
        companyAddress: blankToNull(branding.companyAddress),
        companyWebsite: blankToNull(branding.companyWebsite),
        brandColor: blankToNull(branding.brandColor),
      });
      toast("Branding saved", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to save branding"), "error");
    } finally {
      setSavingBranding(false);
    }
  }

  return (
    <>
      <PageHeader title="Travel settings" subtitle="Module configuration (singleton)." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>
              {settings ? `Last updated ${formatDateTime(settings.updatedAt)}` : "Loading…"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings && (
              <form onSubmit={handleSave} className="space-y-4">
                <div>
                  <Label>Company timezone</Label>
                  <Input value={form.companyTz} onChange={(e) => setForm({ ...form, companyTz: e.target.value })} required />
                  <p className="mt-1 text-xs text-muted-foreground">IANA name, e.g. Asia/Yerevan. Package code dates use it.</p>
                </div>
                <div>
                  <Label>Overdue reminder (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="disabled"
                    value={form.overdueReminderHours}
                    onChange={(e) => setForm({ ...form, overdueReminderHours: e.target.value })}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.requireSettingsForIssue}
                    onChange={(e) => setForm({ ...form, requireSettingsForIssue: e.target.checked })}
                  />
                  Require active policy + FX before issuing
                </label>
                <div>
                  <Label>Infant max age</Label>
                  <Input
                    type="number"
                    min={0}
                    max={12}
                    value={form.infantMaxAge}
                    onChange={(e) => setForm({ ...form, infantMaxAge: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    A child whose age at return is at or below this counts as an infant. Infant counts are
                    auto-filled from child ages on new requests.
                  </p>
                </div>
                <div>
                  <Label>Travel WhatsApp account</Label>
                  {waAccounts.length > 0 ? (
                    <Select value={accountKey} onValueChange={setAccountKey}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {waAccounts.map((a) => (
                          <SelectItem key={a.key} value={a.key}>
                            {a.displayName} ({a.key}){a.enabled ? "" : " — disabled"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={accountKey} onChange={(e) => setAccountKey(e.target.value)} />
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Every travel-module WhatsApp send (documents, notifications) goes through this account — there
                    is no fallback to another account. Pair and enable accounts under Admin → WhatsApp accounts.
                  </p>
                </div>
                <div>
                  <Label>Validator group</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Members are notified on submit and receive the internal costing sheet; the first member is
                    assigned as validator on new requests. Decision rights always belong to the single assigned
                    validator.
                  </p>
                  <div className="mt-2 max-h-48 space-y-1 overflow-auto rounded-lg border bg-card p-2">
                    {assignableUsers.length === 0 && (
                      <p className="text-xs text-muted-foreground">No active users found.</p>
                    )}
                    {assignableUsers.map((u) => {
                      const selected = validatorIds.includes(u.id);
                      return (
                        <label key={u.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() =>
                              setValidatorIds(
                                selected ? validatorIds.filter((id) => id !== u.id) : [...validatorIds, u.id],
                              )
                            }
                          />
                          <span>
                            {u.name || u.email} ({u.role ?? "USER"})
                            {u.phone ? (
                              <span className="text-muted-foreground"> · +{u.phone}</span>
                            ) : (
                              <span className="font-medium text-amber-600">
                                {" "}· no phone — set it in Admin → Users
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {validatorIds.some((id) => !assignableUsers.find((u) => u.id === id)?.phone) && (
                    <p className="mt-1 text-xs font-medium text-amber-600">
                      Some selected members have no WhatsApp phone — they will be skipped for WhatsApp delivery.
                    </p>
                  )}
                </div>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save settings"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Company branding</CardTitle>
            <CardDescription>
              Shown on the client quotation PDF cover and footer. Frozen into each issued document.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {settings && (
              <form onSubmit={handleSaveBranding} className="space-y-4">
                <div>
                  <Label>Company name</Label>
                  <Input
                    value={branding.companyName}
                    onChange={(e) => setBranding({ ...branding, companyName: e.target.value })}
                    placeholder="defaults to the client agency name"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label>Phone</Label>
                    <Input
                      value={branding.companyPhone}
                      onChange={(e) => setBranding({ ...branding, companyPhone: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>Email</Label>
                    <Input
                      type="email"
                      value={branding.companyEmail}
                      onChange={(e) => setBranding({ ...branding, companyEmail: e.target.value })}
                    />
                  </div>
                </div>
                <div>
                  <Label>Website</Label>
                  <Input
                    value={branding.companyWebsite}
                    onChange={(e) => setBranding({ ...branding, companyWebsite: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Address</Label>
                  <Input
                    value={branding.companyAddress}
                    onChange={(e) => setBranding({ ...branding, companyAddress: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Brand color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      className="h-9 w-12 cursor-pointer rounded border"
                      value={branding.brandColor || "#16305b"}
                      onChange={(e) => setBranding({ ...branding, brandColor: e.target.value })}
                    />
                    <Input
                      className="w-28 font-mono"
                      placeholder="#16305b"
                      value={branding.brandColor}
                      onChange={(e) => setBranding({ ...branding, brandColor: e.target.value })}
                    />
                    {branding.brandColor && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setBranding({ ...branding, brandColor: "" })}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Hex #rrggbb; defaults to navy #16305b on the PDF when unset.
                  </p>
                </div>
                <Button type="submit" disabled={savingBranding}>
                  {savingBranding ? "Saving..." : "Save branding"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current configuration</CardTitle>
            <CardDescription>Read-only details.</CardDescription>
          </CardHeader>
          <CardContent>
            {settings && (
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Documents directory</dt>
                  <dd className="font-mono text-xs">{settings.documentsDir}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Escalation user id</dt>
                  <dd className="font-mono text-xs">{settings.escalationUserId ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Active pricing policy</dt>
                  <dd>
                    {activePolicy ? (
                      <>
                        {activePolicy.name} — {activePolicy.type.replace(/_/g, " ")}, rate {formatFractionPercent(activePolicy.rate)},
                        quote currency {activePolicy.quoteCurrency}
                      </>
                    ) : (
                      "None active — issuing is blocked while the setting above is on."
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">FX &amp; policies</dt>
                  <dd>
                    <Button variant="outline" size="sm" onClick={() => (window.location.href = "/travel/catalog")}>
                      Open catalog → FX &amp; Policy tab
                    </Button>
                  </dd>
                </div>
              </dl>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
