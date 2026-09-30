"use client";

import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { COST_CATEGORIES, PRICING_BASES } from "@/lib/travel/contracts";
import { nightsBetween, splitStayIntervals, formatDisplayDate, formatDisplayDateRange } from "@/lib/travel/engine/dates";
import DateField from "../DateField";
import { StateBadge, apiError, basisLabel, hotelDisplayName, money, parseJson } from "../utils";
import type { HotelProductView, VehicleTypeView } from "../types";
import type { DetailContext } from "./RequestDetail";

const VEHICLE_BASES = new Set(["VEHICLE_TRIP", "VEHICLE_DAY"]);

interface AllocationDraft {
  roomType: string;
  rooms: number;
  adults: number;
  children: number;
  infants: number;
  extraBeds: number;
  capacityAdults: number;
  capacityChildren: number;
  capacityTotal: number;
  extraBedAllowed: boolean;
  extraBedIncludedInRate: boolean;
  wholeUnit: boolean;
}

/** Per-allocation manual rate override. actorId is stamped server-side. */
interface RateOverrideDraft {
  rate: string;
  reason: string;
}

interface StayDraft {
  key: string;
  hotelProductId: string | null;
  hotelName: string;
  city: string;
  checkIn: string;
  checkOut: string;
  board: string;
  allocations: AllocationDraft[];
  rateOverrides: Record<string, RateOverrideDraft>;
}

interface ScenarioDraft {
  key: string;
  label: string;
  stays: StayDraft[];
}

interface ServiceLineDraft {
  key: string;
  scenarioKey: string | null;
  category: string;
  label: string;
  basis: string;
  currency: string;
  unitRate: string;
  quantity: string;
  participants: string;
  capacity: string;
  includedElsewhere: boolean;
  isStaffCost: boolean;
  overrideRate: string;
  overrideReason: string;
  sourceRef: string;
  /** Catalog link echoed through the editor so day-linked lines survive saves. */
  serviceProductId: string | null;
  /** YYYY-MM-DD of the itinerary day this line is pinned to; null = not day-linked. */
  date: string | null;
  /** Selected fleet vehicle (per-vehicle SERVICE rate); null = vehicle-agnostic base rate. */
  vehicleTypeId: string | null;
}

const ROOM_TYPES = ["SGL", "DBL", "TPL", "UNIT"];
let keyCounter = 0;
const nextKey = () => `new-${++keyCounter}`;

// Stored overrides may carry a stamped actorId — strip it; the server stamps
// the current user on save and the payload must not echo actor ids.
function parseRateOverrides(raw: string | null): Record<string, RateOverrideDraft> {
  const parsed = parseJson<Record<string, { rate: string; reason: string }> | null>(raw, null);
  if (!parsed) return {};
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, { rate: v.rate, reason: v.reason }]));
}

function defaultAllocation(hotel?: HotelProductView): AllocationDraft {
  return {
    roomType: "DBL",
    rooms: 1,
    adults: 2,
    children: 0,
    infants: 0,
    extraBeds: 0,
    capacityAdults: hotel?.capacityAdults ?? 2,
    capacityChildren: hotel?.capacityChildren ?? 0,
    capacityTotal: hotel?.capacityTotal ?? 2,
    extraBedAllowed: hotel?.extraBedAllowed ?? false,
    extraBedIncludedInRate: false,
    wholeUnit: hotel?.kind === "COTTAGE_UNIT",
  };
}

export default function ScenariosTab({ ctx }: { ctx: DetailContext }) {
  const { toast } = useToast();
  const { version, detail } = ctx;
  const editable = ctx.canEditVersion;

  const [scenarios, setScenarios] = useState<ScenarioDraft[]>([]);
  const [lines, setLines] = useState<ServiceLineDraft[]>([]);
  const [hotels, setHotels] = useState<HotelProductView[]>([]);
  const [vehicles, setVehicles] = useState<VehicleTypeView[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [splitFor, setSplitFor] = useState<{ sc: number; stay: number } | null>(null);
  const [splitFrom, setSplitFrom] = useState("");
  const [splitTo, setSplitTo] = useState("");
  const [jsonFor, setJsonFor] = useState<number | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [removeScenarioIdx, setRemoveScenarioIdx] = useState<number | null>(null);

  // Hydrate editor state whenever a different version is selected or reloaded.
  useEffect(() => {
    setScenarios(
      version.scenarios.map((sc) => ({
        key: sc.id,
        label: sc.label,
        stays: sc.stays.map((st) => ({
          key: st.id,
          hotelProductId: st.hotelProductId,
          hotelName: st.hotelName,
          city: st.city ?? "",
          checkIn: st.checkIn,
          checkOut: st.checkOut,
          board: st.board ?? "",
          allocations: parseJson<AllocationDraft[]>(st.allocations, []),
          rateOverrides: parseRateOverrides(st.rateOverrides),
        })),
      })),
    );
    setLines(
      version.serviceLines.map((l) => ({
        key: l.id,
        scenarioKey: l.scenarioId,
        category: l.category,
        label: l.label,
        basis: l.basis,
        currency: l.currency,
        unitRate: l.unitRate ?? "",
        quantity: l.quantity,
        participants: l.participants == null ? "" : String(l.participants),
        capacity: l.capacity == null ? "" : String(l.capacity),
        includedElsewhere: l.includedElsewhere,
        isStaffCost: l.isStaffCost,
        overrideRate: l.overrideRate ?? "",
        overrideReason: l.overrideReason ?? "",
        sourceRef: l.sourceRef ?? "",
        serviceProductId: l.serviceProductId,
        date: l.date,
        vehicleTypeId: l.vehicleTypeId,
      })),
    );
    setDirty(false);
  }, [version]);

  useEffect(() => {
    axios
      .get("/api/travel/catalog/hotels")
      .then((res) => setHotels(res.data))
      .catch(() => null);
    axios
      .get("/api/travel/catalog/vehicles")
      .then((res) => setVehicles(res.data))
      .catch(() => null);
  }, []);

  const scenarioName = useMemo(() => {
    const map = new Map<string, string>();
    for (const sc of scenarios) map.set(sc.key, sc.label);
    return (key: string | null) => (key ? map.get(key) ?? "?" : "Shared");
  }, [scenarios]);

  function mutate(fn: () => void) {
    fn();
    setDirty(true);
  }

  function updateScenario(si: number, patch: Partial<ScenarioDraft>) {
    mutate(() => setScenarios((prev) => prev.map((s, i) => (i === si ? { ...s, ...patch } : s))));
  }

  function updateStay(si: number, ti: number, patch: Partial<StayDraft>) {
    mutate(() =>
      setScenarios((prev) =>
        prev.map((s, i) =>
          i === si ? { ...s, stays: s.stays.map((t, j) => (j === ti ? { ...t, ...patch } : t)) } : s,
        ),
      ),
    );
  }

  function selectHotel(si: number, ti: number, hotelId: string) {
    const hotel = hotels.find((h) => h.id === hotelId);
    if (!hotel) return;
    const boards = parseJson<string[]>(hotel.boardOptions, []);
    const stay = scenarios[si].stays[ti];
    updateStay(si, ti, {
      hotelProductId: hotel.id,
      hotelName: hotel.name,
      city: hotel.city ?? "",
      board: boards[0] ?? stay.board,
      allocations: stay.allocations.length
        ? stay.allocations.map((a) => ({
            ...a,
            capacityAdults: hotel.capacityAdults,
            capacityChildren: hotel.capacityChildren,
            capacityTotal: hotel.capacityTotal,
            extraBedAllowed: hotel.extraBedAllowed,
            wholeUnit: hotel.kind === "COTTAGE_UNIT" ? true : a.wholeUnit,
          }))
        : [defaultAllocation(hotel)],
    });
  }

  function updateAllocation(si: number, ti: number, ai: number, patch: Partial<AllocationDraft>) {
    const stay = scenarios[si].stays[ti];
    updateStay(si, ti, {
      allocations: stay.allocations.map((a, i) => (i === ai ? { ...a, ...patch } : a)),
    });
  }

  function addScenario() {
    const src = scenarios[scenarios.length - 1];
    const key = nextKey();
    mutate(() =>
      setScenarios((prev) => [
        ...prev,
        src
          ? {
              key,
              label: `Option ${String.fromCharCode(65 + prev.length)}`,
              stays: src.stays.map((t) => ({
                ...t,
                key: nextKey(),
                allocations: t.allocations.map((a) => ({ ...a })),
                rateOverrides: { ...t.rateOverrides },
              })),
            }
          : {
              key,
              label: "Option A",
              stays: [
                {
                  key: nextKey(),
                  hotelProductId: null,
                  hotelName: "TBD",
                  city: "",
                  checkIn: detail.startDate,
                  checkOut: detail.endDate,
                  board: "",
                  allocations: [defaultAllocation()],
                  rateOverrides: {},
                },
              ],
            },
      ]),
    );
  }

  function removeScenario(si: number) {
    const key = scenarios[si].key;
    const bound = lines.filter((l) => l.scenarioKey === key).length;
    // With lines attached, deletion is destructive enough to ask first.
    if (bound > 0) {
      setRemoveScenarioIdx(si);
      return;
    }
    doRemoveScenario(si);
  }

  function doRemoveScenario(si: number) {
    const key = scenarios[si].key;
    mutate(() => {
      setScenarios((prev) => prev.filter((_, i) => i !== si));
      // Lines bound to the removed scenario are deleted with it.
      setLines((prev) => prev.filter((l) => l.scenarioKey !== key));
    });
  }

  function addStay(si: number) {
    const sc = scenarios[si];
    updateScenario(si, {
      stays: [
        ...sc.stays,
        {
          key: nextKey(),
          hotelProductId: null,
          hotelName: "TBD",
          city: "",
          checkIn: detail.startDate,
          checkOut: detail.endDate,
          board: "",
          allocations: [defaultAllocation()],
          rateOverrides: {},
        },
      ],
    });
  }

  function removeStay(si: number, ti: number) {
    const sc = scenarios[si];
    updateScenario(si, { stays: sc.stays.filter((_, j) => j !== ti) });
  }

  // ---- split stay ------------------------------------------------------------

  const splitPreview = useMemo(() => {
    if (!splitFor) return null;
    const stay = scenarios[splitFor.sc]?.stays[splitFor.stay];
    if (!stay || !splitFrom || !splitTo) return null;
    try {
      return splitStayIntervals([{ checkIn: stay.checkIn, checkOut: stay.checkOut }], {
        checkIn: splitFrom,
        checkOut: splitTo,
      });
    } catch (err: any) {
      return err?.message ?? "invalid split";
    }
  }, [splitFor, splitFrom, splitTo, scenarios]);

  function applySplit() {
    if (!splitFor || !Array.isArray(splitPreview)) return;
    const { sc, stay } = splitFor;
    const source = scenarios[sc].stays[stay];
    mutate(() =>
      setScenarios((prev) =>
        prev.map((s, i) =>
          i === sc
            ? {
                ...s,
                stays: s.stays.flatMap((t, j) =>
                  j === stay
                    ? splitPreview.map((p) => ({
                        ...source,
                        key: nextKey(),
                        checkIn: p.checkIn,
                        checkOut: p.checkOut,
                        allocations: source.allocations.map((a) => ({ ...a })),
                        rateOverrides: { ...source.rateOverrides },
                      }))
                    : [t],
                ),
              }
            : s,
        ),
      ),
    );
    setSplitFor(null);
    toast("Stay split — review the segments, then save", "info");
  }

  // ---- service lines ----------------------------------------------------------

  function updateLine(li: number, patch: Partial<ServiceLineDraft>) {
    mutate(() => setLines((prev) => prev.map((l, i) => (i === li ? { ...l, ...patch } : l))));
  }

  function addLine() {
    mutate(() =>
      setLines((prev) => [
        ...prev,
        {
          key: nextKey(),
          scenarioKey: null,
          category: "EXTRA_SERVICES",
          label: "",
          basis: "PER_PERSON",
          currency: "AMD",
          unitRate: "",
          quantity: "1",
          participants: "",
          capacity: "",
          includedElsewhere: false,
          isStaffCost: false,
          overrideRate: "",
          overrideReason: "",
          sourceRef: "",
          serviceProductId: null,
          date: null,
          vehicleTypeId: null,
        },
      ]),
    );
  }

  // ---- persistence ------------------------------------------------------------
  async function handleSave() {
    setSaving(true);
    try {
      await axios.put(`/api/travel/versions/${version.id}/content`, {
        expectedRevision: detail.revision,
        scenarios: scenarios.map((s) => ({
          key: s.key,
          label: s.label,
          stays: s.stays.map((t) => ({
            hotelProductId: t.hotelProductId,
            hotelName: t.hotelName,
            city: t.city || null,
            checkIn: t.checkIn,
            checkOut: t.checkOut,
            board: t.board || null,
            allocations: t.allocations,
            rateOverrides: Object.keys(t.rateOverrides).length ? t.rateOverrides : null,
          })),
        })),
        serviceLines: lines.map((l) => ({
          scenarioKey: l.scenarioKey,
          category: l.category,
          label: l.label || "Untitled line",
          basis: l.basis,
          currency: l.currency || "AMD",
          unitRate: l.unitRate === "" ? null : l.unitRate,
          quantity: l.quantity || "1",
          participants: l.participants === "" ? null : Number.parseInt(l.participants, 10),
          capacity: l.capacity === "" ? null : Number.parseInt(l.capacity, 10),
          includedElsewhere: l.includedElsewhere,
          isStaffCost: l.isStaffCost,
          overrideRate: l.overrideRate === "" ? null : l.overrideRate,
          overrideReason: l.overrideReason === "" ? null : l.overrideReason,
          sourceRef: l.sourceRef || null,
          serviceProductId: l.serviceProductId,
          date: l.date,
          vehicleTypeId: l.vehicleTypeId,
        })),
      });
      toast("Scenario content saved", "success");
      setDirty(false);
      ctx.refresh();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        toast("This request was edited elsewhere — refreshed the latest data. Review and save again.", "error");
        ctx.refresh();
      } else {
        toast(apiError(err, "Failed to save content"), "error");
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- JSON fallback ------------------------------------------------------------

  function openJson(si: number) {
    setJsonFor(si);
    setJsonText(JSON.stringify(scenarios[si], null, 2));
  }

  function applyJson() {
    if (jsonFor == null) return;
    try {
      const parsed = JSON.parse(jsonText) as ScenarioDraft;
      if (!parsed || typeof parsed.label !== "string" || !Array.isArray(parsed.stays)) {
        throw new Error("expected { key, label, stays: [...] }");
      }
      parsed.key = scenarios[jsonFor].key; // key stays stable so line references survive
      parsed.stays = parsed.stays.map((t) => ({ ...t, rateOverrides: t.rateOverrides ?? {} }));
      updateScenario(jsonFor, parsed);
      setJsonFor(null);
      toast("JSON applied — not saved yet", "info");
    } catch (err: any) {
      toast(`Invalid JSON: ${err?.message ?? "parse error"}`, "error");
    }
  }

  // ---- render -------------------------------------------------------------------

  // Prices come from the shared summary (ctx.quoteResults) — this tab no longer
  // runs its own calculation. Internal costing is gated on the admin-granted
  // travel.internal.view permission; other users are redacted server-side.
  const canSeeInternal = ctx.permissions.includes("travel.internal.view");
  // ISO dates compare lexicographically; check-out must be strictly after check-in.
  const hasInvalidStayDates = scenarios.some((sc) => sc.stays.some((t) => !(t.checkOut > t.checkIn)));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Scenarios</CardTitle>
              <CardDescription>
                Stay segments per option; service lines are edited once, below. Prices update in the quote
                summary after every save.
                {editable ? "" : " Read-only for this version status."}
                {editable && dirty && (
                  <span className="block text-amber-700">Unsaved changes — save to update the prices above.</span>
                )}
                {editable && hasInvalidStayDates && (
                  <span className="block text-red-600">
                    Check-out must be after check-in on every stay — fix the dates before saving.
                  </span>
                )}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {editable && (
                <>
                  <Button variant="outline" size="sm" onClick={addScenario}>
                    Add scenario
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={!dirty || saving || hasInvalidStayDates}>
                    {saving ? "Saving..." : "Save content"}
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {scenarios.map((sc, si) => {
        const persisted = version.scenarios.find((p) => p.id === sc.key);
        const result = ctx.quoteResults?.get(sc.key) ?? null;
        const currency = ctx.resultCurrency;
        return (
          <Card key={sc.key}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  {editable ? (
                    <Input
                      className="w-48"
                      value={sc.label}
                      onChange={(e) => updateScenario(si, { label: e.target.value })}
                    />
                  ) : (
                    <CardTitle className="text-base">{sc.label}</CardTitle>
                  )}
                  {persisted && (
                    <Badge variant={persisted.valid ? "success" : "neutral"}>
                      {persisted.valid ? "valid" : "not validated"}
                    </Badge>
                  )}
                </div>
                {editable && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => openJson(si)}>
                      JSON
                    </Button>
                    {scenarios.length > 1 && (
                      <Button variant="destructive" size="sm" onClick={() => removeScenario(si)}>
                        Remove
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* stays */}
              <div className="space-y-3">
                {sc.stays.map((stay, ti) => (
                  <StayEditor
                    key={stay.key}
                    stay={stay}
                    editable={editable}
                    hotels={hotels}
                    onChange={(patch) => updateStay(si, ti, patch)}
                    onSelectHotel={(id) => selectHotel(si, ti, id)}
                    onAllocation={(ai, patch) => updateAllocation(si, ti, ai, patch)}
                    onAddAllocation={() =>
                      updateStay(si, ti, {
                        allocations: [
                          ...stay.allocations,
                          defaultAllocation(hotels.find((h) => h.id === stay.hotelProductId)),
                        ],
                      })
                    }
                    onRemoveAllocation={(ai) =>
                      updateStay(si, ti, { allocations: stay.allocations.filter((_, j) => j !== ai) })
                    }
                    onSplit={() => {
                      setSplitFor({ sc: si, stay: ti });
                      setSplitFrom(stay.checkIn);
                      setSplitTo(stay.checkOut);
                    }}
                    onRemove={() => removeStay(si, ti)}
                  />
                ))}
                {editable && (
                  <Button variant="outline" size="sm" onClick={() => addStay(si)}>
                    Add stay segment
                  </Button>
                )}

                {/* Per-stay nightly costs (v0.11.0): nightly[] rows carry
                    AMD/quote conversions; absent on redacted or old snapshots. */}
                {canSeeInternal &&
                  result?.nightly?.some((n) => n.amountAmd != null) &&
                  sc.stays.map((stay) => {
                    const rows = (result.nightly ?? []).filter(
                      (n) => n.stayRef === stay.key && n.amountAmd != null,
                    );
                    if (rows.length === 0) return null;
                    const sum = (key: "amountAmd" | "amountQuote") =>
                      String(Math.round(rows.reduce((acc, n) => acc + Number(n[key] ?? 0), 0) * 100) / 100);
                    return (
                      <div key={stay.key} className="rounded-lg border bg-muted/20 px-3 py-2 text-xs [font-variant-numeric:tabular-nums]">
                        <p className="mb-1 font-medium">
                          {stay.hotelName}
                          {stay.city ? ` · ${stay.city}` : ""} — {rows.length} night row(s)
                        </p>
                        <ul className="space-y-0.5 text-muted-foreground">
                          {rows.map((n, ni) => (
                            <li key={ni} className="flex items-baseline justify-between gap-4">
                              <span>
                                {formatDisplayDate(n.date)} · {n.roomType} ×{n.rooms}
                                {n.extraBeds > 0 ? ` +${n.extraBeds} bed(s)` : ""}
                              </span>
                              <span className="text-right">
                                {money(n.amountAmd, "AMD")}
                                {n.amountQuote != null && currency !== "AMD" ? ` · ${money(n.amountQuote, currency)}` : ""}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1 flex items-baseline justify-between gap-4 border-t pt-1 font-medium">
                          <span>Stay total</span>
                          <span className="text-right">
                            {money(sum("amountAmd"), "AMD")}
                            {currency !== "AMD" ? ` · ${money(sum("amountQuote"), currency)}` : ""}
                          </span>
                        </p>
                      </div>
                    );
                  })}
              </div>

              {/* result summary (from the shared quote preview) */}
              {result && (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm [font-variant-numeric:tabular-nums]">
                  <div className="flex flex-wrap items-center gap-3">
                    <StateBadge value={result.valid ? "READY" : "FAILED"} />
                    <span>
                      Sell: <strong>{money(result.sell, currency)}</strong>
                    </span>
                    {result.perPayingPerson && <span>Per paying person: {money(result.perPayingPerson, currency)}</span>}
                    <span>
                      {result.nights} night{result.nights === 1 ? "" : "s"} / {result.days} days
                    </span>
                  </div>
                  {/* Internal costing is redacted for users without
                      travel.internal.view — render it only when the result
                      actually carries those fields. */}
                  {canSeeInternal && result.totals && (
                    <div className="mt-2 flex flex-wrap gap-3 border-t pt-2 text-xs text-muted-foreground">
                      <span>Internal — cost {money(result.totals.costQuote, currency)}</span>
                      <span>profit {money(result.profit, currency)}</span>
                      <span>margin {result.margin != null ? `${(Number(result.margin) * 100).toFixed(1)}%` : "—"}</span>
                    </div>
                  )}
                  {!canSeeInternal && (
                    <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                      Internal costing requires an admin-granted permission.
                    </p>
                  )}
                  {result.issues.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t pt-2">
                      {result.issues.map((iss, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <StateBadge value={iss.severity} />
                          <span className="font-mono">{iss.code}</span>
                          <span>{iss.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Service lines</CardTitle>
            {editable && (
              <Button variant="outline" size="sm" onClick={addLine}>
                Add service line
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ServiceLineTable
            lines={lines.map((l, i) => ({ l, i }))}
            editable={editable}
            scenarioName={scenarioName}
            scenarios={scenarios}
            vehicles={vehicles}
            onChange={updateLine}
            onRemove={(li) => mutate(() => setLines((prev) => prev.filter((_, j) => j !== li)))}
          />
        </CardContent>
      </Card>

      {/* split dialog */}
      <Dialog open={splitFor !== null} onOpenChange={(open) => !open && setSplitFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Split stay segment</DialogTitle>
            <DialogDescription>
              Insert a sub-interval; the parent stay splits around it (e.g. 5 nights → 2+2+1). The inserted
              piece keeps the same rooms — change its hotel after applying.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Insert from</Label>
              <DateField value={splitFrom} onChange={setSplitFrom} />
            </div>
            <div>
              <Label>Insert to (exclusive)</Label>
              <DateField value={splitTo} onChange={setSplitTo} />
            </div>
          </div>
          {splitPreview && (
            <div className="rounded-md border p-3 text-sm">
              {Array.isArray(splitPreview) ? (
                <ul className="space-y-1">
                  {splitPreview.map((p, i) => (
                    <li key={i}>
                      {formatDisplayDateRange(p.checkIn, p.checkOut)} ({nightsBetween(p.checkIn, p.checkOut)} night
                      {nightsBetween(p.checkIn, p.checkOut) === 1 ? "" : "s"})
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-red-600">{splitPreview}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={applySplit} disabled={!Array.isArray(splitPreview)}>
              Apply split
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* JSON fallback dialog */}
      <Dialog open={jsonFor !== null} onOpenChange={(open) => !open && setJsonFor(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Advanced: raw scenario JSON</DialogTitle>
            <DialogDescription>
              Power editing. Shape: {"{ key, label, stays: [{ hotelProductId, hotelName, city, checkIn, checkOut, board, allocations: [...] }] }"}
              . The key is preserved on apply so service-line references survive.
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={16} className="font-mono text-xs" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
          <DialogFooter>
            <Button onClick={applyJson}>Apply JSON</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeScenarioIdx !== null} onOpenChange={(open) => !open && setRemoveScenarioIdx(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this scenario?</DialogTitle>
            <DialogDescription>
              {removeScenarioIdx !== null &&
                `${lines.filter((l) => l.scenarioKey === scenarios[removeScenarioIdx]?.key).length} service line(s) attached to it will be deleted with it.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveScenarioIdx(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removeScenarioIdx !== null) doRemoveScenario(removeScenarioIdx);
                setRemoveScenarioIdx(null);
              }}
            >
              Remove scenario
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function StayEditor({
  stay,
  editable,
  hotels,
  onChange,
  onSelectHotel,
  onAllocation,
  onAddAllocation,
  onRemoveAllocation,
  onSplit,
  onRemove,
}: {
  stay: StayDraft;
  editable: boolean;
  hotels: HotelProductView[];
  onChange: (patch: Partial<StayDraft>) => void;
  onSelectHotel: (id: string) => void;
  onAllocation: (ai: number, patch: Partial<AllocationDraft>) => void;
  onAddAllocation: () => void;
  onRemoveAllocation: (ai: number) => void;
  onSplit: () => void;
  onRemove: () => void;
}) {
  const nights = nightsBetween(stay.checkIn, stay.checkOut);
  const hasOverrides = Object.keys(stay.rateOverrides).length > 0;
  const invalidDates = !(stay.checkOut > stay.checkIn);
  return (
    <div className="rounded-lg border bg-muted/10 p-3">
      {hasOverrides && (
        <div className="mb-2">
          <Badge variant="warning">override</Badge>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_110px_130px_130px_90px]">
        {editable ? (
          <>
            <Select value={stay.hotelProductId ?? ""} onValueChange={onSelectHotel}>
              <SelectTrigger>
                <SelectValue placeholder={stay.hotelName || "Select hotel"} />
              </SelectTrigger>
              <SelectContent>
                {hotels.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {hotelDisplayName(h)}
                    {h.city ? ` (${h.city}, ${h.country})` : ` (${h.country})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Board" value={stay.board} onChange={(e) => onChange({ board: e.target.value })} />
            <DateField value={stay.checkIn} onChange={(iso) => onChange({ checkIn: iso })} />
            <DateField value={stay.checkOut} onChange={(iso) => onChange({ checkOut: iso })} />
            <div className="flex gap-1">
              <Button variant="outline" size="sm" onClick={onSplit}>
                Split
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-muted-foreground hover:text-destructive"
                aria-label="Remove stay segment"
                onClick={onRemove}
              >
                <X />
              </Button>
            </div>
          </>
        ) : (
          <div className="col-span-5 text-sm">
            <span className="font-medium">{stay.hotelName}</span>
            {stay.city && <span className="text-muted-foreground"> · {stay.city}</span>}
            <span className="text-muted-foreground">
              {" "}
              · {formatDisplayDateRange(stay.checkIn, stay.checkOut)} ({nights} night{nights === 1 ? "" : "s"})
              {stay.board ? ` · ${stay.board}` : ""}
            </span>
          </div>
        )}
      </div>
      {editable && invalidDates && (
        <p className="mt-2 text-xs text-red-600">Check-out must be after check-in.</p>
      )}
      {editable && !stay.hotelProductId && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Input placeholder="Hotel name" value={stay.hotelName} onChange={(e) => onChange({ hotelName: e.target.value })} />
          <Input placeholder="City" value={stay.city} onChange={(e) => onChange({ city: e.target.value })} />
        </div>
      )}
      <div className="mt-2 space-y-2">
        {stay.allocations.map((a, ai) =>
          editable ? (
            <div key={ai} className="grid items-end gap-2 rounded-lg border bg-card p-2 sm:grid-cols-[90px_repeat(6,1fr)_auto]">
              <div>
                <span className="text-xs text-muted-foreground">Room type</span>
                <Select value={a.roomType} onValueChange={(v) => onAllocation(ai, { roomType: v })}>
                  <SelectTrigger className="h-8 text-[13px]">
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
                  ["rooms", "Rooms"],
                  ["adults", "Adults"],
                  ["children", "Children"],
                  ["infants", "Infants"],
                  ["extraBeds", "Extra beds"],
                  ["capacityTotal", "Capacity"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 text-right text-[13px] [font-variant-numeric:tabular-nums]"
                    value={a[key]}
                    onChange={(e) => onAllocation(ai, { [key]: Math.max(0, Number.parseInt(e.target.value || "0", 10) || 0) })}
                  />
                </div>
              ))}
              <div className="flex items-center gap-3 pb-1 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={a.wholeUnit}
                    onChange={(e) => onAllocation(ai, { wholeUnit: e.target.checked })}
                  />
                  Whole unit
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={a.extraBedIncludedInRate}
                    onChange={(e) => onAllocation(ai, { extraBedIncludedInRate: e.target.checked })}
                  />
                  Bed in rate
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  aria-label="Remove room row"
                  onClick={() => onRemoveAllocation(ai)}
                >
                  <X />
                </Button>
              </div>
            </div>
          ) : (
            <p key={ai} className="text-xs text-muted-foreground">
              {a.rooms}× {a.roomType} — {a.adults}A{a.children ? `/${a.children}C` : ""}
              {a.infants ? `/${a.infants}I` : ""}
              {a.extraBeds ? ` +${a.extraBeds} extra bed${a.extraBeds === 1 ? "" : "s"}` : ""}
              {a.wholeUnit ? " (whole unit)" : ""}
            </p>
          ),
        )}
        {editable && (
          <Button variant="outline" size="sm" onClick={onAddAllocation}>
            Add room row
          </Button>
        )}
      </div>
    </div>
  );
}

function ServiceLineTable({
  lines,
  editable,
  scenarioName,
  scenarios,
  vehicles,
  onChange,
  onRemove,
}: {
  lines: { l: ServiceLineDraft; i: number }[];
  editable: boolean;
  scenarioName: (key: string | null) => string;
  scenarios: ScenarioDraft[];
  vehicles: VehicleTypeView[];
  onChange: (i: number, patch: Partial<ServiceLineDraft>) => void;
  onRemove: (i: number) => void;
}) {
  if (lines.length === 0) return <p className="text-xs text-muted-foreground">No service lines.</p>;
  const vehicleName = (id: string | null) => (id ? vehicles.find((v) => v.id === id)?.name ?? "?" : null);
  if (!editable) {
    const byCategory = new Map<string, ServiceLineDraft[]>();
    for (const { l } of lines) {
      const arr = byCategory.get(l.category) ?? [];
      arr.push(l);
      byCategory.set(l.category, arr);
    }
    return (
      <div className="space-y-2">
        {Array.from(byCategory.entries()).map(([cat, catLines]) => (
          <div key={cat}>
            <p className="text-xs font-semibold text-muted-foreground">{cat.replace(/_/g, " ")}</p>
            <ul className="ml-2 space-y-0.5 text-sm">
              {catLines.map((l) => (
                <li key={l.key}>
                  {l.label} — {basisLabel(l.basis, l.capacity ? Number(l.capacity) : null)} · {money(l.unitRate, l.currency)} × {l.quantity}
                  {l.participants != null ? ` · ${l.participants} pax` : ""}
                  {vehicleName(l.vehicleTypeId) ? ` · ${vehicleName(l.vehicleTypeId)}` : ""}
                  {l.includedElsewhere ? " · included elsewhere" : ""}
                  {l.isStaffCost ? " · staff" : ""}
                  {l.serviceProductId && (
                    <>
                      {" "}
                      <Badge variant="outline" title={l.date ? `Itinerary day ${formatDisplayDate(l.date)}` : "Itinerary-linked"}>
                        itinerary{l.date ? ` · ${formatDisplayDate(l.date)}` : ""}
                      </Badge>
                    </>
                  )}
                  {l.overrideRate && (
                    <>
                      {" "}
                      <Badge variant="warning">override</Badge>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {lines.map(({ l, i }) =>
        // Day-linked lines are managed on the Itinerary tab — editing them
        // here would fight the itinerary sync on every save, so they render
        // as compact read-only rows.
        l.serviceProductId ? (
          <div key={l.key} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
            <span className="font-medium">{l.label}</span>
            <Badge variant="outline" title={l.date ? `Itinerary day ${formatDisplayDate(l.date)}` : "Itinerary-linked"}>
              itinerary{l.date ? ` · ${formatDisplayDate(l.date)}` : ""}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {basisLabel(l.basis, l.capacity ? Number(l.capacity) : null)}
              {l.quantity !== "1" ? ` × ${l.quantity}` : ""}
              {vehicleName(l.vehicleTypeId) ? ` · ${vehicleName(l.vehicleTypeId)}` : ""}
              {l.scenarioKey ? ` · ${scenarioName(l.scenarioKey)}` : ""}
            </span>
            {l.overrideRate && <Badge variant="warning">override</Badge>}
            <span className="ml-auto text-xs text-muted-foreground">Managed on the Itinerary tab</span>
          </div>
        ) : (
        <div key={l.key} className="grid items-end gap-2 rounded-lg border bg-card p-2 lg:grid-cols-[1.4fr_1fr_1fr_70px_90px_70px_70px_70px_110px_auto]">
          <div>
            <span className="text-xs text-muted-foreground">
              Label {l.overrideRate && <Badge variant="warning">override</Badge>}
            </span>
            <Input className="h-8 text-[13px]" value={l.label} onChange={(e) => onChange(i, { label: e.target.value })} />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Category</span>
            <Select value={l.category} onValueChange={(v) => onChange(i, { category: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COST_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Basis</span>
            <Select value={l.basis} onValueChange={(v) => onChange(i, { basis: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRICING_BASES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {VEHICLE_BASES.has(l.basis) && (
            <div>
              <span className="text-xs text-muted-foreground">Vehicle</span>
              <Select
                value={l.vehicleTypeId ?? "ANY"}
                onValueChange={(v) => onChange(i, { vehicleTypeId: v === "ANY" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANY">Any / default</SelectItem>
                  {vehicles.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} ({v.seats})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <span className="text-xs text-muted-foreground">Currency</span>
            <Input className="h-8 text-[13px]" value={l.currency} onChange={(e) => onChange(i, { currency: e.target.value.toUpperCase() })} />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Unit rate</span>
            <Input
              placeholder="TBC"
              className="h-8 text-right text-[13px] [font-variant-numeric:tabular-nums]"
              value={l.unitRate}
              onChange={(e) => onChange(i, { unitRate: e.target.value })}
            />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Qty</span>
            <Input
              className="h-8 text-right text-[13px] [font-variant-numeric:tabular-nums]"
              value={l.quantity}
              onChange={(e) => onChange(i, { quantity: e.target.value })}
            />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Pax</span>
            <Input
              className="h-8 text-right text-[13px] [font-variant-numeric:tabular-nums]"
              value={l.participants}
              onChange={(e) => onChange(i, { participants: e.target.value })}
            />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Capacity</span>
            <Input
              className="h-8 text-right text-[13px] [font-variant-numeric:tabular-nums]"
              value={l.capacity}
              onChange={(e) => onChange(i, { capacity: e.target.value })}
            />
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Scenario</span>
            <Select
              value={l.scenarioKey ?? "SHARED"}
              onValueChange={(v) => onChange(i, { scenarioKey: v === "SHARED" ? null : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SHARED">Shared</SelectItem>
                {scenarios.map((s) => (
                  <SelectItem key={s.key} value={s.key}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-1 text-xs">
            <label className="flex items-center gap-1" title="Already included in a bundle/board">
              <input
                type="checkbox"
                checked={l.includedElsewhere}
                onChange={(e) => onChange(i, { includedElsewhere: e.target.checked })}
              />
              Incl.
            </label>
            <label className="flex items-center gap-1" title="Staff cost — not multiplied by guest pax">
              <input type="checkbox" checked={l.isStaffCost} onChange={(e) => onChange(i, { isStaffCost: e.target.checked })} />
              Staff
            </label>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              aria-label="Remove service line"
              onClick={() => onRemove(i)}
            >
              <X />
            </Button>
          </div>
        </div>
        ),
      )}
      <p className="text-xs text-muted-foreground">
        {lines.filter(({ l }) => l.scenarioKey === null).length} shared · grouped per scenario:{" "}
        {Array.from(new Set(lines.map(({ l }) => scenarioName(l.scenarioKey)))).join(", ")}
      </p>
    </div>
  );
}
