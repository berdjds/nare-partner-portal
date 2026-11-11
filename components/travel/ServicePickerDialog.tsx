"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { basisLabel, parseJson } from "./utils";
import type { ServiceProductView, VehicleTypeView } from "./types";

export type ServicePickerTab = "tours" | "tickets" | "services";

/** What the parent receives for catalog picks, vehicle picks and custom labels. */
export interface PickedService {
  serviceProductId: string | null;
  label: string;
  /** Catalog long description (v0.14.0); the client quotation prints it next to the label. */
  details?: string | null;
  vehicleTypeId: string | null;
}

/**
 * Only per-vehicle bases take a fleet vehicle. Per-seat group tours are
 * TRANSPORTATION too but sell seats on a fixed departure — attaching a vehicle
 * to them mislabels the line ("· Sedan" on a shared tour).
 */
function needsVehicle(p: ServiceProductView): boolean {
  return p.basis === "VEHICLE_TRIP" || p.basis === "VEHICLE_DAY";
}

const ISO_WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Wed · Fri · Sun" from a JSON ISO-weekday array ("[3,5,7]"), else null. */
function weekdaysLabel(raw: string | null): string | null {
  const days = parseJson<number[]>(raw, []);
  if (days.length === 0) return null;
  return days.map((d) => ISO_WEEKDAY_SHORT[d] ?? String(d)).join(" · ");
}

interface SectionDef {
  tab: ServicePickerTab;
  title: string;
  match: (p: ServiceProductView) => boolean;
}

// Catalog grouping: tours split by pricing model first, then friendly labels
// in catalog order; anything unmatched lands in "Other" (Services tab) so a
// new category never silently disappears from the picker.
const SECTION_DEFS: SectionDef[] = [
  { tab: "tours", title: "Tours — private vehicle", match: (p) => p.category === "TRANSPORTATION" && needsVehicle(p) },
  { tab: "tours", title: "Group tours — per seat", match: (p) => p.category === "TRANSPORTATION" && !needsVehicle(p) },
  { tab: "tickets", title: "Tickets & degustations", match: (p) => p.category === "TICKETS" },
  { tab: "services", title: "Meals", match: (p) => p.category === "GUEST_MEALS" },
  { tab: "services", title: "Guides", match: (p) => p.category === "GUIDES" },
  {
    tab: "services",
    title: "Staff costs",
    match: (p) => p.category === "STAFF_ACCOMMODATION" || p.category === "STAFF_MEALS",
  },
  { tab: "services", title: "Tour leader", match: (p) => p.category === "TOUR_LEADER" },
  { tab: "services", title: "Extra services", match: (p) => p.category === "EXTRA_SERVICES" },
];

const TAB_LABELS: { value: ServicePickerTab; label: string }[] = [
  { value: "tours", label: "Tours" },
  { value: "tickets", label: "Tickets & degustations" },
  { value: "services", label: "Services" },
];

const TAB_EMPTY: Record<ServicePickerTab, string> = {
  tours: "No tours in the catalog.",
  tickets: "No tickets in the catalog.",
  services: "No other services in the catalog.",
};

interface ServicePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tab shown when the dialog opens; switchable inside. */
  initialTab?: ServicePickerTab;
  title: string;
  description?: string;
  products: ServiceProductView[] | null;
  vehicles: VehicleTypeView[];
  /**
   * Indicative-rate hint for a product (optionally in a chosen vehicle), e.g.
   * "12000 AMD · ≈ 32.88 USD". Dates and FX live with the parent; omit the prop
   * for no hints.
   */
  rateHint?: (p: ServiceProductView, vehicleTypeId?: string) => string | null;
  /** Fired on catalog picks, vehicle-confirmed picks and custom labels. The parent decides whether to close the dialog. */
  onPick: (item: PickedService) => void;
}

export default function ServicePickerDialog({
  open,
  onOpenChange,
  initialTab = "tours",
  title,
  description,
  products,
  vehicles,
  rateHint,
  onPick,
}: ServicePickerDialogProps) {
  const [tab, setTab] = useState<ServicePickerTab>(initialTab);
  const [query, setQuery] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  // Vehicle-priced product clicked in the list, awaiting a vehicle choice.
  const [pendingVehicleProduct, setPendingVehicleProduct] = useState<ServiceProductView | null>(null);
  const [pickerVehicle, setPickerVehicle] = useState("");

  // Fresh state on every open: back to the caller's tab, no stale search text
  // or half-finished vehicle pick from the previous day.
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setQuery("");
      setCustomLabel("");
      setPendingVehicleProduct(null);
      setPickerVehicle("");
    }
  }, [open, initialTab]);

  // Search filters within the active tab: sections are built per tab from the
  // query-filtered catalog, so other tabs' products never show.
  const queryLower = query.trim().toLowerCase();
  const catalog = (products ?? []).filter((p) => !queryLower || p.name.toLowerCase().includes(queryLower));
  const sections = SECTION_DEFS.filter((def) => def.tab === tab).map((def) => ({
    title: def.title,
    items: catalog.filter(def.match),
  }));
  if (tab === "services") {
    // "Other" is catalog-wide unmatched — unknown categories surface here
    // instead of vanishing when a new category is introduced upstream.
    const assigned = new Set<string>();
    for (const def of SECTION_DEFS) for (const p of catalog.filter(def.match)) assigned.add(p.id);
    sections.push({ title: "Other", items: catalog.filter((p) => !assigned.has(p.id)) });
  }
  const visibleSections = sections.filter((s) => s.items.length > 0);

  function pickProduct(p: ServiceProductView) {
    if (needsVehicle(p) && vehicles.length > 0) {
      // Second step: the same product in two vehicles is two distinct lines.
      setPendingVehicleProduct(p);
      setPickerVehicle((prev) => prev || vehicles[0].id);
      return;
    }
    onPick({ serviceProductId: p.id, label: p.name, details: p.details ?? null, vehicleTypeId: null });
  }

  function confirmVehicleProduct() {
    if (!pendingVehicleProduct || !pickerVehicle) return;
    onPick({
      serviceProductId: pendingVehicleProduct.id,
      label: pendingVehicleProduct.name,
      details: pendingVehicleProduct.details ?? null,
      vehicleTypeId: pickerVehicle,
    });
    setPendingVehicleProduct(null);
  }

  function addCustom() {
    const label = customLabel.trim();
    if (!label) return;
    onPick({ serviceProductId: null, label, vehicleTypeId: null });
    setCustomLabel("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as ServicePickerTab)}>
          <TabsList className="grid w-full grid-cols-3">
            {TAB_LABELS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="text-xs sm:text-sm">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="space-y-3">
          {products === null && <p className="text-sm text-muted-foreground">Loading catalog…</p>}
          {pendingVehicleProduct && (
            <div className="flex items-end gap-2 rounded-lg border bg-muted/30 p-2">
              <div className="flex-1">
                <p className="mb-1 text-xs font-medium">
                  {pendingVehicleProduct.name} — vehicle
                  {pickerVehicle && rateHint?.(pendingVehicleProduct, pickerVehicle) && (
                    <span className="ms-2 font-normal text-muted-foreground">
                      {rateHint(pendingVehicleProduct, pickerVehicle)}
                    </span>
                  )}
                </p>
                <Select value={pickerVehicle} onValueChange={setPickerVehicle}>
                  <SelectTrigger aria-label="Vehicle type">
                    <SelectValue placeholder="Select vehicle" />
                  </SelectTrigger>
                  <SelectContent>
                    {vehicles.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name} ({v.seats} seats)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" onClick={confirmVehicleProduct} disabled={!pickerVehicle}>
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPendingVehicleProduct(null)}>
                Back
              </Button>
            </div>
          )}
          <Input placeholder="Search services…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="max-h-[55vh] space-y-3 overflow-y-auto">
            {products !== null && visibleSections.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {queryLower
                  ? "No services match this search."
                  : products.length === 0
                    ? "No active services in the catalog."
                    : TAB_EMPTY[tab]}
              </p>
            )}
            {visibleSections.map((section) => (
              <div key={section.title}>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{section.title}</p>
                <div className="space-y-1">
                  {section.items.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`w-full rounded-lg border bg-card px-3 py-2 text-start text-sm transition-colors hover:bg-muted${
                        pendingVehicleProduct?.id === p.id ? " border-primary ring-1 ring-primary" : ""
                      }`}
                      onClick={() => pickProduct(p)}
                    >
                      <span className="break-words">{p.name}</span>
                      {p.details && (
                        <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">{p.details}</span>
                      )}
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {basisLabel(p.basis, p.capacity)}
                        {p.durationVariant ? ` · ${p.durationVariant.replace(/_/g, " ")}` : ""}
                        {needsVehicle(p) ? " · per vehicle" : ""}
                        {p.category === "TRANSPORTATION" && !needsVehicle(p) && weekdaysLabel(p.weekdays)
                          ? ` · departs ${weekdaysLabel(p.weekdays)}`
                          : ""}
                        {rateHint?.(p) ? ` · ${rateHint(p)}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 border-t pt-3">
            <Input
              placeholder="Custom label…"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustom();
                }
              }}
            />
            <Button variant="outline" size="sm" onClick={addCustom} disabled={!customLabel.trim()}>
              Add custom
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
