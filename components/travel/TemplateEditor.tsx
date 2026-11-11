"use client";

import { useEffect, useState } from "react";
import axios from "axios";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import TravelShell from "./TravelShell";
import ServicePickerDialog from "./ServicePickerDialog";
import { apiError, hotelDisplayName, parseJson } from "./utils";
import type {
  HotelProductView,
  ServiceProductView,
  TemplateView,
  TemplateVersionView,
  VehicleTypeView,
} from "./types";
import type { TemplateDay, TemplateScenario } from "@/lib/travel/templates";

const ROOM_TYPES = ["SGL", "DBL", "TPL", "UNIT"];
// Radix Select forbids empty-string item values, hence the CUSTOM sentinel
// for "no catalog hotel — free-text name".
const CUSTOM_HOTEL = "CUSTOM";

interface ServiceDraft {
  serviceProductId: string | null;
  label: string;
  quantity: number | null;
  vehicleTypeId: string | null;
  /** Phase 2 template rule (strict, validated by the server). The editor does not author it yet but must carry it through a save. */
  rule?: unknown;
}

interface DayDraft {
  narrative: string;
  overnightCity: string;
  services: ServiceDraft[];
}

interface AllocDraft {
  roomType: string;
  rooms: number;
  adults: number;
  children: number;
  infants: number;
  extraBeds: number;
}

interface StayDraft {
  hotelProductId: string | null;
  hotelName: string;
  city: string;
  board: string;
  checkInOffset: number;
  nights: number;
  allocations: AllocDraft[];
}

interface ScenarioDraft {
  key?: string;
  label: string;
  stays: StayDraft[];
}

const EMPTY_ALLOC: AllocDraft = { roomType: "DBL", rooms: 1, adults: 2, children: 0, infants: 0, extraBeds: 0 };

export default function TemplateEditor({ templateId, role }: { templateId: string; role: string }) {
  const { toast } = useToast();
  const [template, setTemplate] = useState<TemplateView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [versionId, setVersionId] = useState("");
  const [name, setName] = useState("");
  const [days, setDays] = useState<DayDraft[]>([]);
  // null = the version has no default scenarios (distinct from an empty list,
  // which the server rejects — scenarios carry at least one stay).
  const [scenarios, setScenarios] = useState<ScenarioDraft[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [products, setProducts] = useState<ServiceProductView[] | null>(null);
  const [vehicles, setVehicles] = useState<VehicleTypeView[]>([]);
  const [hotels, setHotels] = useState<HotelProductView[]>([]);

  const [pickerDay, setPickerDay] = useState<number | null>(null);
  const [discardFor, setDiscardFor] = useState<string | null>(null);

  const version: TemplateVersionView | undefined = template?.versions.find((v) => v.id === versionId);

  function loadVersion(t: TemplateView, v: TemplateVersionView) {
    setName(t.name);
    setDays(
      parseJson<TemplateDay[]>(v.daysJson, []).map((d) => ({
        narrative: d.narrative ?? "",
        overnightCity: d.overnightCity ?? "",
        services: (d.services ?? []).map((s) => ({
          serviceProductId: s.serviceProductId ?? null,
          label: s.label,
          quantity: s.quantity ?? null,
          vehicleTypeId: s.vehicleTypeId ?? null,
          rule: (s as { rule?: unknown }).rule ?? null,
        })),
      })),
    );
    const parsedScenarios = v.scenariosJson ? parseJson<TemplateScenario[]>(v.scenariosJson, []) : null;
    setScenarios(
      parsedScenarios?.map((s) => ({
        key: s.key,
        label: s.label,
        stays: s.stays.map((st) => ({
          hotelProductId: st.hotelProductId ?? null,
          hotelName: st.hotelName ?? "",
          city: st.city ?? "",
          board: st.board ?? "",
          checkInOffset: st.checkInOffset,
          nights: st.nights,
          allocations: st.allocations.map((a) => ({ ...a })),
        })),
      })) ?? null,
    );
    setDirty(false);
  }

  async function reload(selectVersionId?: string) {
    try {
      const res = await axios.get("/api/travel/templates");
      const t = (res.data as TemplateView[]).find((x) => x.id === templateId);
      if (!t) {
        setNotFound(true);
        return;
      }
      setTemplate(t);
      const v =
        t.versions.find((x) => x.id === (selectVersionId ?? versionId)) ??
        t.versions.find((x) => x.status === "ACTIVE") ??
        t.versions[0];
      if (v) {
        setVersionId(v.id);
        loadVersion(t, v);
      }
    } catch (err) {
      toast(apiError(err, "Failed to load template"), "error");
    }
  }

  useEffect(() => {
    reload();
    axios
      .get("/api/travel/catalog/services")
      .then((res) => setProducts(res.data))
      .catch((err) => toast(apiError(err, "Failed to load service catalog"), "error"));
    axios
      .get("/api/travel/catalog/vehicles")
      .then((res) => setVehicles(res.data))
      .catch(() => null);
    axios
      .get("/api/travel/catalog/hotels")
      .then((res) => setHotels(res.data))
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  function switchVersion(nextId: string) {
    // Switching discards unsaved edits — confirm instead of losing them silently.
    if (dirty) {
      setDiscardFor(nextId);
      return;
    }
    doSwitchVersion(nextId);
  }

  function doSwitchVersion(nextId: string) {
    const v = template?.versions.find((x) => x.id === nextId);
    if (!template || !v) return;
    setVersionId(nextId);
    loadVersion(template, v);
  }

  // --- day / service mutations -------------------------------------------------

  function patchDay(di: number, patch: Partial<DayDraft>) {
    setDays((ds) => ds.map((d, i) => (i === di ? { ...d, ...patch } : d)));
    setDirty(true);
  }

  function patchService(di: number, si: number, patch: Partial<ServiceDraft>) {
    setDays((ds) =>
      ds.map((d, i) =>
        i === di ? { ...d, services: d.services.map((s, j) => (j === si ? { ...s, ...patch } : s)) } : d,
      ),
    );
    setDirty(true);
  }

  function addService(di: number, service: ServiceDraft) {
    setDays((ds) => ds.map((d, i) => (i === di ? { ...d, services: [...d.services, service] } : d)));
    setDirty(true);
  }

  // --- scenario mutations --------------------------------------------------------

  function patchScenario(si: number, patch: Partial<ScenarioDraft>) {
    setScenarios((ss) => ss && ss.map((s, i) => (i === si ? { ...s, ...patch } : s)));
    setDirty(true);
  }

  function patchStay(si: number, ti: number, patch: Partial<StayDraft>) {
    setScenarios(
      (ss) =>
        ss &&
        ss.map((s, i) =>
          i === si ? { ...s, stays: s.stays.map((st, j) => (j === ti ? { ...st, ...patch } : st)) } : s,
        ),
    );
    setDirty(true);
  }

  function patchAlloc(si: number, ti: number, ai: number, patch: Partial<AllocDraft>) {
    setScenarios(
      (ss) =>
        ss &&
        ss.map((s, i) =>
          i === si
            ? {
                ...s,
                stays: s.stays.map((st, j) =>
                  j === ti
                    ? { ...st, allocations: st.allocations.map((a, k) => (k === ai ? { ...a, ...patch } : a)) }
                    : st,
                ),
              }
            : s,
        ),
    );
    setDirty(true);
  }

  // --- save -----------------------------------------------------------------------

  async function handleSave() {
    if (!template || !version) return;
    if (!name.trim()) {
      toast("Template name is required", "error");
      return;
    }
    setSaving(true);
    try {
      await axios.put(`/api/travel/templates/${template.id}/versions/${version.id}`, {
        name: name.trim(),
        days: days.map((d, i) => ({
          dayOffset: i,
          narrative: d.narrative.trim() || null,
          overnightCity: d.overnightCity.trim() || null,
          services: d.services.length > 0 ? d.services : null,
        })),
        scenarios:
          scenarios === null
            ? null
            : scenarios.map((s) => ({
                ...(s.key ? { key: s.key } : {}),
                label: s.label,
                stays: s.stays.map((st) => ({
                  hotelProductId: st.hotelProductId,
                  hotelName: st.hotelName.trim() || null,
                  city: st.city.trim() || null,
                  board: st.board.trim() || null,
                  checkInOffset: st.checkInOffset,
                  nights: st.nights,
                  allocations: st.allocations,
                })),
              })),
      });
      toast("Template saved", "success");
      await reload(version.id);
    } catch (err) {
      toast(apiError(err, "Failed to save template"), "error");
    } finally {
      setSaving(false);
    }
  }

  // Length preview matches templateLength(): scenarios are authoritative for
  // nights; otherwise the day rows set the trip length (last row = departure).
  const previewNights =
    scenarios && scenarios.length > 0
      ? Math.max(0, ...scenarios.flatMap((s) => s.stays.map((st) => st.checkInOffset + st.nights)))
      : Math.max(0, days.length - 1);

  function vehicleName(id: string | null): string | null {
    return id ? vehicles.find((v) => v.id === id)?.name ?? null : null;
  }

  if (notFound) {
    return (
      <TravelShell title="Package templates" subtitle="Template not found." role={role} current="templates">
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Template not found. <a className="underline" href="/travel/templates">Back to templates</a>
          </CardContent>
        </Card>
      </TravelShell>
    );
  }

  return (
    <TravelShell
      title={template ? `Template ${template.code}` : "Package templates"}
      subtitle="Edit template content; changes apply to future instantiations only."
      role={role}
      current="templates"
      breadcrumb={[
        { label: "Templates", href: "/travel/templates" },
        { label: template?.code ?? "…" },
      ]}
    >
      {!template || !version ? (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">Loading…</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-72">
                    <Label>Template name</Label>
                    <Input aria-label="Template name"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                  <div>
                    <Label>Version</Label>
                    <Select value={versionId} onValueChange={switchVersion}>
                      <SelectTrigger className="w-48">
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
                  <Badge variant={version.status === "ACTIVE" ? "success" : "neutral"}>{version.status}</Badge>
                  <span className="pb-2 text-xs text-muted-foreground">
                    will save as {previewNights}n/{scenarios && scenarios.length > 0 ? previewNights + 1 : days.length}d
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => (window.location.href = "/travel/templates")}>
                    Back
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
                    {saving ? "Saving..." : "Save template"}
                  </Button>
                </div>
              </div>
              <CardDescription>
                Catalog-linked services become priced lines at instantiate; legacy label-only services stay narrative.
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Days</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDays((ds) => [...ds, { narrative: "", overnightCity: "", services: [] }]);
                    setDirty(true);
                  }}
                >
                  Add day
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {days.map((d, di) => (
                <div key={di} className="rounded-lg border bg-muted/10 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">Day {di + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setDays((ds) => ds.filter((_, i) => i !== di));
                        setDirty(true);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_200px]">
                    <Textarea
                      rows={2}
                      placeholder="Narrative"
                      value={d.narrative}
                      onChange={(e) => patchDay(di, { narrative: e.target.value })}
                    />
                    <Input
                      placeholder="Overnight city"
                      value={d.overnightCity}
                      onChange={(e) => patchDay(di, { overnightCity: e.target.value })}
                    />
                  </div>
                  <div className="mt-2 space-y-1">
                    {d.services.map((s, si) => (
                      <div key={si} className="flex items-center gap-2 rounded-lg border bg-card px-2 py-1 text-sm">
                        <span className="flex-1">
                          {s.label}
                          {vehicleName(s.vehicleTypeId) && (
                            <span className="ms-1 text-xs text-muted-foreground">· {vehicleName(s.vehicleTypeId)}</span>
                          )}
                          {!s.serviceProductId && (
                            <span className="ms-1 text-xs text-muted-foreground">(label only)</span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">qty</span>
                        <Input
                          type="number"
                          min={1}
                          className="h-7 w-16"
                          value={s.quantity ?? ""}
                          placeholder="1"
                          onChange={(e) =>
                            patchService(di, si, {
                              quantity: e.target.value === "" ? null : Math.max(1, Number.parseInt(e.target.value, 10) || 1),
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDays((ds) =>
                              ds.map((x, i) => (i === di ? { ...x, services: x.services.filter((_, j) => j !== si) } : x)),
                            );
                            setDirty(true);
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPickerDay(di)}
                    >
                      Add service
                    </Button>
                  </div>
                </div>
              ))}
              {days.length === 0 && <p className="text-sm text-muted-foreground">No days yet.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Default hotel scenarios</CardTitle>
                  <CardDescription>
                    Dates are relative: check-in = trip start + offset. Copied into new requests at instantiate.
                  </CardDescription>
                </div>
                {scenarios === null ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setScenarios([
                        {
                          label: "Option A",
                          stays: [
                            {
                              hotelProductId: null,
                              hotelName: "",
                              city: "",
                              board: "",
                              checkInOffset: 0,
                              nights: Math.max(1, days.length - 1),
                              allocations: [{ ...EMPTY_ALLOC }],
                            },
                          ],
                        },
                      ]);
                      setDirty(true);
                    }}
                  >
                    Add scenario
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setScenarios((ss) => [
                        ...(ss ?? []),
                        {
                          label: `Option ${String.fromCharCode(65 + (ss?.length ?? 0))}`,
                          stays: [
                            {
                              hotelProductId: null,
                              hotelName: "",
                              city: "",
                              board: "",
                              checkInOffset: 0,
                              nights: Math.max(1, days.length - 1),
                              allocations: [{ ...EMPTY_ALLOC }],
                            },
                          ],
                        },
                      ]);
                      setDirty(true);
                    }}
                  >
                    Add scenario
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {scenarios === null && (
                <p className="text-sm text-muted-foreground">
                  No default scenarios — instantiated requests start with the usual TBD stay.
                </p>
              )}
              {scenarios?.map((s, si) => (
                <div key={si} className="rounded-lg border bg-muted/10 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Input
                      className="w-56"
                      placeholder="Scenario label"
                      value={s.label}
                      onChange={(e) => patchScenario(si, { label: e.target.value })}
                    />
                    <div className="ms-auto flex gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          patchScenario(si, {
                            stays: [
                              ...s.stays,
                              {
                                hotelProductId: null,
                                hotelName: "",
                                city: "",
                                board: "",
                                checkInOffset: 0,
                                nights: 1,
                                allocations: [{ ...EMPTY_ALLOC }],
                              },
                            ],
                          });
                        }}
                      >
                        Add stay
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setScenarios((ss) => {
                            const next = (ss ?? []).filter((_, i) => i !== si);
                            // Clearing the last scenario means "no defaults" (null), not an empty list.
                            return next.length > 0 ? next : null;
                          });
                          setDirty(true);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {s.stays.map((st, ti) => (
                      <div key={ti} className="rounded-lg border bg-card p-2">
                        <div className="grid items-end gap-2 sm:grid-cols-[1fr_90px_110px_110px_90px_auto]">
                          <div>
                            <span className="text-xs text-muted-foreground">Hotel</span>
                            <Select
                              value={st.hotelProductId ?? CUSTOM_HOTEL}
                              onValueChange={(v) => {
                                if (v === CUSTOM_HOTEL) {
                                  patchStay(si, ti, { hotelProductId: null });
                                } else {
                                  const h = hotels.find((x) => x.id === v);
                                  patchStay(si, ti, {
                                    hotelProductId: v,
                                    hotelName: h ? hotelDisplayName(h) : st.hotelName,
                                    city: st.city || h?.city || "",
                                  });
                                }
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select hotel" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={CUSTOM_HOTEL}>Custom / unlisted</SelectItem>
                                {hotels.map((h) => (
                                  <SelectItem key={h.id} value={h.id}>
                                    {hotelDisplayName(h)}
                                    {h.city ? ` (${h.city})` : ""}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">Board</span>
                            <Input value={st.board} onChange={(e) => patchStay(si, ti, { board: e.target.value })} />
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">Check-in offset</span>
                            <Input
                              type="number"
                              min={0}
                              value={st.checkInOffset}
                              onChange={(e) =>
                                patchStay(si, ti, {
                                  checkInOffset: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0),
                                })
                              }
                            />
                          </div>
                          <div>
                            <span className="text-xs text-muted-foreground">Nights</span>
                            <Input
                              type="number"
                              min={1}
                              value={st.nights}
                              onChange={(e) =>
                                patchStay(si, ti, { nights: Math.max(1, Number.parseInt(e.target.value || "1", 10) || 1) })
                              }
                            />
                          </div>
                          <div className="pb-1 text-xs text-muted-foreground">
                            day {st.checkInOffset + 1} → {st.checkInOffset + st.nights + 1}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              patchScenario(si, { stays: s.stays.filter((_, j) => j !== ti) });
                            }}
                            disabled={s.stays.length <= 1}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                        {!st.hotelProductId && (
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <Input
                              placeholder="Hotel name"
                              value={st.hotelName}
                              onChange={(e) => patchStay(si, ti, { hotelName: e.target.value })}
                            />
                            <Input
                              placeholder="City"
                              value={st.city}
                              onChange={(e) => patchStay(si, ti, { city: e.target.value })}
                            />
                          </div>
                        )}
                        <div className="mt-2 space-y-1">
                          {st.allocations.map((a, ai) => (
                            <div key={ai} className="grid items-end gap-2 sm:grid-cols-[100px_repeat(5,70px)_auto]">
                              <div>
                                <span className="text-xs text-muted-foreground">Room type</span>
                                <Select value={a.roomType} onValueChange={(v) => patchAlloc(si, ti, ai, { roomType: v })}>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {ROOM_TYPES.map((rt) => (
                                      <SelectItem key={rt} value={rt}>
                                        {rt}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                              {(
                                [
                                  ["rooms", "Rooms", 1],
                                  ["adults", "Adults", 0],
                                  ["children", "Children", 0],
                                  ["infants", "Infants", 0],
                                  ["extraBeds", "X-beds", 0],
                                ] as const
                              ).map(([key, label, min]) => (
                                <div key={key}>
                                  <span className="text-xs text-muted-foreground">{label}</span>
                                  <Input
                                    type="number"
                                    min={min}
                                    value={a[key]}
                                    onChange={(e) =>
                                      patchAlloc(si, ti, ai, {
                                        [key]: Math.max(min, Number.parseInt(e.target.value || "0", 10) || 0),
                                      })
                                    }
                                  />
                                </div>
                              ))}
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  patchStay(si, ti, { allocations: st.allocations.filter((_, k) => k !== ai) })
                                }
                                disabled={st.allocations.length <= 1}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ))}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => patchStay(si, ti, { allocations: [...st.allocations, { ...EMPTY_ALLOC }] })}
                          >
                            Add room row
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      <ServicePickerDialog
        open={pickerDay !== null}
        onOpenChange={(open) => !open && setPickerDay(null)}
        initialTab="services"
        title={`Add service — day ${pickerDay !== null ? pickerDay + 1 : ""}`}
        description="Catalog services become priced lines at instantiate; custom labels stay narrative."
        products={products}
        vehicles={vehicles}
        onPick={(item) => {
          // Stays open for multi-add — template days typically take several services.
          if (pickerDay === null) return;
          addService(pickerDay, { ...item, quantity: null });
        }}
      />

      <Dialog open={discardFor !== null} onOpenChange={(open) => !open && setDiscardFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Switching versions throws away the edits you have not saved yet.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscardFor(null)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (discardFor) doSwitchVersion(discardFor);
                setDiscardFor(null);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TravelShell>
  );
}
