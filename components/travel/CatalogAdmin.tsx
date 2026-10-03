"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import axios from "axios";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { badgeStatusTextStyles } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { COST_CATEGORIES, PRICING_BASES, RATE_STATUSES } from "@/lib/travel/contracts";
import { formatDisplayDate } from "@/lib/travel/engine/dates";
import DateField from "./DateField";
import TravelShell from "./TravelShell";
import { StateBadge, apiError, basisLabel, formatDateTime, hotelDisplayName, money, parseJson } from "./utils";
import type {
  Agency,
  FxVersionView,
  HotelProductView,
  ImportBatchView,
  ImportRowView,
  PolicyView,
  RateView,
  ServiceProductView,
  SupplierOption,
  VehicleTypeView,
} from "./types";

interface CatalogAdminProps {
  role: string;
  userId: string;
}

export default function CatalogAdmin({ role, userId }: CatalogAdminProps) {
  return (
    <TravelShell title="Travel catalog" subtitle="Hotels, services, rates, FX, policies, imports and agencies." role={role} current="catalog">
      <Tabs defaultValue="hotels" className="space-y-4">
        {/* Page-level tabs: underline style (segmented is for in-card sets). */}
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0">
          {[
            ["hotels", "Hotels"],
            ["services", "Services"],
            ["rates", "Rates"],
            ["fxpolicy", "FX & Policy"],
            ["imports", "Imports"],
            ["agencies", "Agencies"],
          ].map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="hotels">
          <HotelsTab />
        </TabsContent>
        <TabsContent value="services">
          <ServicesTab />
        </TabsContent>
        <TabsContent value="rates">
          <RatesTab />
        </TabsContent>
        <TabsContent value="fxpolicy">
          <FxPolicyTab />
        </TabsContent>
        <TabsContent value="imports">
          <ImportsTab />
        </TabsContent>
        <TabsContent value="agencies">
          <AgenciesTab />
        </TabsContent>
      </Tabs>
    </TravelShell>
  );
}

// ---------------------------------------------------------------------------
// Shared catalog CRUD helpers
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const OCCUPANCIES = ["SGL", "DBL", "TPL", "EXTRA_BED", "UNIT"] as const;
const DURATION_VARIANTS = ["half_day", "full_day", "transfer"] as const;
/** Radix Select rejects empty-string values, so "no value" uses a sentinel. */
const NONE = "__none__";

// ---------------------------------------------------------------------------
// Drag-and-drop ordering (v0.13.1) — admin-defined sortOrder, persisted via
// the catalog reorder endpoints; every picker consumes the same GET order.
// ---------------------------------------------------------------------------

function SortableTableRow({
  id,
  disabled,
  className,
  children,
}: {
  id: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <TableRow
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(className, isDragging && "relative z-10 bg-card shadow-md")}
    >
      <TableCell className="w-8 px-2">
        <button
          type="button"
          aria-label="Drag to reorder"
          disabled={disabled}
          {...attributes}
          {...listeners}
          className={cn(
            "inline-flex size-6 items-center justify-center rounded text-muted-foreground",
            disabled
              ? "cursor-not-allowed opacity-30"
              : "cursor-grab hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          )}
        >
          <GripVertical className="size-4" />
        </button>
      </TableCell>
      {children}
    </TableRow>
  );
}

/** Shared DnD wiring for the Hotels/Services tables: sensors + optimistic reorder. */
function useCatalogReorder<T extends { id: string }>(
  items: T[],
  setItems: React.Dispatch<React.SetStateAction<T[]>>,
  endpoint: string
) {
  const { toast } = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = items.findIndex((i) => i.id === active.id);
      const newIndex = items.findIndex((i) => i.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      const next = arrayMove(items, oldIndex, newIndex);
      setItems(next);
      axios
        .post(endpoint, { ids: next.map((i) => i.id) })
        .then(() => toast("Order saved — pickers now show this order.", "success"))
        .catch((err) => {
          setItems(items);
          toast(apiError(err, "Failed to save order"), "error");
        });
    },
    [items, setItems, endpoint, toast]
  );

  return { sensors, onDragEnd };
}

/** Rates/fees are stored as decimal fractions; display as trimmed percent (0.14 → "14%"). */
function fractionPercent(value: string | null): string {
  if (!value) return "—";
  const n = Number(value) * 100;
  if (!Number.isFinite(n)) return value;
  // toFixed + Number drops binary-float noise and trailing zeros (0.16 → 16, not 16.000000000000004).
  return `${Number(n.toFixed(4))}%`;
}

/** Validity band display: ISO dates formatted, open ends shown as "…". */
function validityLabel(from: string | null, to: string | null): string {
  return `${from ? formatDisplayDate(from) : "…"} → ${to ? formatDisplayDate(to) : "…"}`;
}

function weekdaysSummary(raw: string | null | undefined): string {
  const days = parseJson<number[]>(raw, []);
  return days.length ? days.map((n) => WEEKDAY_LABELS[n - 1] ?? String(n)).join(", ") : "—";
}

function useSuppliers(): SupplierOption[] {
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  useEffect(() => {
    axios
      .get("/api/travel/catalog/suppliers")
      .then((res) => setSuppliers(res.data))
      .catch(() => {});
  }, []);
  return suppliers;
}

function useVehicles(): VehicleTypeView[] {
  const [vehicles, setVehicles] = useState<VehicleTypeView[]>([]);
  useEffect(() => {
    axios
      .get("/api/travel/catalog/vehicles")
      .then((res) => setVehicles(res.data))
      .catch(() => {});
  }, []);
  return vehicles;
}

function WeekdayPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-3">
      {WEEKDAY_LABELS.map((label, i) => {
        const n = i + 1;
        const checked = value.includes(n);
        return (
          <label key={n} className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...value, n].sort((a, b) => a - b) : value.filter((x) => x !== n),
                )
              }
            />
            {label}
          </label>
        );
      })}
    </div>
  );
}

function SupplierSelect({
  value,
  onChange,
  suppliers,
}: {
  value: string;
  onChange: (v: string) => void;
  suppliers: SupplierOption[];
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No supplier</SelectItem>
        {suppliers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Optional integer text field → number | null. */
function intOrNull(v: string): number | null {
  const t = v.trim();
  return t === "" ? null : Number(t);
}

/**
 * Shared confirm-delete dialog for catalog entities — the template-delete
 * pattern (shadcn Dialog + destructive button + axios.delete + toast), so
 * every Delete affordance behaves identically. Server guards surface as
 * readable error toasts via apiError.
 */
function ConfirmDeleteDialog({
  title,
  description,
  endpoint,
  successMessage,
  onClose,
  onDeleted,
}: {
  title: string;
  description: string;
  endpoint: string;
  successMessage: string;
  onClose: () => void;
  onDeleted: () => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      await axios.delete(endpoint);
      toast(successMessage, "success");
      await onDeleted();
    } catch (err) {
      toast(apiError(err, "Delete failed"), "error");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={busy}>
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rate create/edit dialog (shared by hotel and service rate editors)
// ---------------------------------------------------------------------------

interface RateFormState {
  occupancy: string;
  board: string;
  vehicleTypeId: string; // SERVICE rates only; "" = vehicle-agnostic base rate
  amount: string; // "" or "TBC" → null server-side
  currency: string;
  validFrom: string;
  validTo: string;
  weekdays: number[];
  minStay: string;
  priority: string;
  notes: string;
}

const EMPTY_RATE_FORM: RateFormState = {
  occupancy: "",
  board: "",
  vehicleTypeId: "",
  amount: "",
  currency: "AMD",
  validFrom: "",
  validTo: "",
  weekdays: [],
  minStay: "",
  priority: "0",
  notes: "",
};

function rateToForm(r: RateView): RateFormState {
  return {
    occupancy: r.occupancy ?? "",
    board: r.board ?? "",
    vehicleTypeId: r.vehicleTypeId ?? "",
    amount: r.amount ?? "",
    currency: r.currency,
    validFrom: r.validFrom ?? "",
    validTo: r.validTo ?? "",
    weekdays: parseJson<number[]>(r.weekdays, []),
    minStay: r.minStay != null ? String(r.minStay) : "",
    priority: String(r.priority),
    notes: r.notes ?? "",
  };
}

function RateDialog({
  productType,
  productId,
  rate,
  open,
  onOpenChange,
  onSaved,
}: {
  productType: "HOTEL" | "SERVICE";
  productId: string;
  rate: RateView | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<RateFormState>(EMPTY_RATE_FORM);
  const [saving, setSaving] = useState(false);
  const vehicles = useVehicles();

  useEffect(() => {
    if (open) setForm(rate ? rateToForm(rate) : EMPTY_RATE_FORM);
  }, [open, rate]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const base = {
      amount: form.amount.trim(),
      currency: form.currency.trim().toUpperCase(),
      validFrom: form.validFrom || null,
      validTo: form.validTo || null,
      weekdays: form.weekdays,
      minStay: intOrNull(form.minStay),
      priority: form.priority.trim() ? Number(form.priority) : 0,
      notes: form.notes.trim() || null,
    };
    try {
      if (rate) {
        // Occupancy/board identify the bracket and are not editable; archive +
        // recreate to move a rate to a different bracket.
        await axios.patch(`/api/travel/catalog/rates/${rate.id}`, base);
        toast("Rate updated", "success");
      } else {
        await axios.post("/api/travel/catalog/rates", {
          productType,
          ...(productType === "HOTEL" ? { hotelProductId: productId } : { serviceProductId: productId }),
          occupancy: productType === "HOTEL" ? form.occupancy || null : null,
          board: form.board.trim() || null,
          vehicleTypeId: productType === "SERVICE" ? form.vehicleTypeId || null : null,
          ...base,
        });
        toast("Rate created (needs review)", "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast(apiError(err, "Failed to save rate"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{rate ? "Edit rate" : "Add rate"}</DialogTitle>
          <DialogDescription>
            {rate
              ? "Amount, currency, validity and notes are editable; edits on verified rates are audit-logged."
              : "New rates start as NEEDS REVIEW until verified on the Rates tab. Leave amount empty for TBC."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {productType === "HOTEL" && (
              <div>
                <Label>Occupancy</Label>
                {rate ? (
                  <Input value={form.occupancy || "—"} disabled />
                ) : (
                  <Select value={form.occupancy || NONE} onValueChange={(v) => setForm({ ...form, occupancy: v === NONE ? "" : v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Any / n/a</SelectItem>
                      {OCCUPANCIES.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o.replace(/_/g, " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            <div>
              <Label>Board</Label>
              {rate ? (
                <Input value={form.board || "—"} disabled />
              ) : (
                <Input
                  placeholder="BB / HB / FB (optional)"
                  value={form.board}
                  onChange={(e) => setForm({ ...form, board: e.target.value })}
                />
              )}
            </div>
            {productType === "SERVICE" && (
              <div>
                <Label>Vehicle (optional — per-vehicle transportation rate)</Label>
                {rate ? (
                  // Like occupancy, the vehicle identifies the rate bracket and
                  // is not editable; archive + recreate to change it.
                  <Input value={vehicles.find((v) => v.id === form.vehicleTypeId)?.name ?? "—"} disabled />
                ) : (
                  <Select
                    value={form.vehicleTypeId || NONE}
                    onValueChange={(v) => setForm({ ...form, vehicleTypeId: v === NONE ? "" : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Any vehicle (base rate)</SelectItem>
                      {vehicles.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name} ({v.seats} seats)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
            <div>
              <Label>Amount (decimal string, empty = TBC)</Label>
              <Input
                placeholder="e.g. 45000 or 45000.00"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div>
              <Label>Currency</Label>
              <Input
                maxLength={3}
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                required
              />
            </div>
            <div>
              <Label>Valid from (optional)</Label>
              <DateField value={form.validFrom} onChange={(iso) => setForm({ ...form, validFrom: iso })} />
            </div>
            <div>
              <Label>Valid to (exclusive, optional)</Label>
              <DateField
                value={form.validTo}
                onChange={(iso) => setForm({ ...form, validTo: iso })}
                min={form.validFrom || undefined}
              />
            </div>
            <div>
              <Label>Min stay (nights, optional)</Label>
              <Input type="number" min={1} value={form.minStay} onChange={(e) => setForm({ ...form, minStay: e.target.value })} />
            </div>
            <div>
              <Label>Priority (higher wins on overlap)</Label>
              <Input type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>Weekdays (leave all unchecked for every day)</Label>
            <WeekdayPicker value={form.weekdays} onChange={(v) => setForm({ ...form, weekdays: v })} />
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : rate ? "Save changes" : "Create rate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rate rows of one product, styled like the workbook price brackets. */
function RateTable({
  rates,
  productType,
  onEdit,
}: {
  rates: RateView[];
  productType: "HOTEL" | "SERVICE";
  onEdit: (r: RateView) => void;
}) {
  if (rates.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">No rates yet.</p>;
  }
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow>
          {productType === "HOTEL" && <TableHead>Occupancy</TableHead>}
          {productType === "SERVICE" && <TableHead>Vehicle</TableHead>}
          <TableHead>Board</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Validity</TableHead>
          <TableHead>Weekdays</TableHead>
          <TableHead>Min stay</TableHead>
          <TableHead>Status</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rates.map((r) => (
          <TableRow key={r.id}>
            {productType === "HOTEL" && <TableCell className="font-medium">{r.occupancy ?? "—"}</TableCell>}
            {productType === "SERVICE" && <TableCell>{r.vehicleType?.name ?? "—"}</TableCell>}
            <TableCell>{r.board ?? "—"}</TableCell>
            <TableCell className="whitespace-nowrap text-right">{r.amount == null ? "TBC" : money(r.amount, r.currency)}</TableCell>
            <TableCell className="whitespace-nowrap">{validityLabel(r.validFrom, r.validTo)}</TableCell>
            <TableCell>{weekdaysSummary(r.weekdays)}</TableCell>
            <TableCell>{r.minStay ?? "—"}</TableCell>
            <TableCell>
              <StateBadge value={r.status} className="px-1.5 py-0 text-[10px]" />
            </TableCell>
            <TableCell>
              <Button size="sm" variant="outline" onClick={() => onEdit(r)}>
                Edit
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Service product create/edit dialog
// ---------------------------------------------------------------------------

interface ServiceFormState {
  name: string;
  details: string;
  category: string;
  basis: string;
  capacity: string;
  language: string;
  durationVariant: string;
  weekdays: number[];
  supplierId: string;
  active: boolean;
}

const EMPTY_SERVICE_FORM: ServiceFormState = {
  name: "",
  details: "",
  category: "EXTRA_SERVICES",
  basis: "PER_PERSON",
  capacity: "",
  language: "",
  durationVariant: "",
  weekdays: [],
  supplierId: "",
  active: true,
};

function serviceToForm(s: ServiceProductView): ServiceFormState {
  return {
    name: s.name,
    details: s.details ?? "",
    category: s.category,
    basis: s.basis,
    capacity: s.capacity != null ? String(s.capacity) : "",
    language: s.language ?? "",
    durationVariant: s.durationVariant ?? "",
    weekdays: parseJson<number[]>(s.weekdays, []),
    supplierId: s.supplier?.id ?? "",
    active: s.active,
  };
}

function ServiceDialog({
  service,
  open,
  onOpenChange,
  onSaved,
  suppliers,
}: {
  service: ServiceProductView | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  suppliers: SupplierOption[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<ServiceFormState>(EMPTY_SERVICE_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(service ? serviceToForm(service) : EMPTY_SERVICE_FORM);
  }, [open, service]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // The engine blocks CAPACITY_BLOCK lines without capacity ≥ 1 — catch it
    // here so a catalog entry can never be saved into that blocker state.
    if (form.basis === "CAPACITY_BLOCK") {
      const cap = intOrNull(form.capacity);
      if (cap == null || cap < 1) {
        toast("Capacity is required for the CAPACITY BLOCK basis (people per group)", "error");
        return;
      }
    }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      details: form.details.trim() || null,
      category: form.category,
      basis: form.basis,
      capacity: intOrNull(form.capacity),
      language: form.language.trim() || null,
      durationVariant: form.durationVariant || null,
      weekdays: form.weekdays,
      supplierId: form.supplierId || null,
      active: form.active,
    };
    try {
      if (service) {
        await axios.patch(`/api/travel/catalog/services/${service.id}`, payload);
        toast("Service updated", "success");
      } else {
        await axios.post("/api/travel/catalog/services", payload);
        toast("Service created", "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast(apiError(err, "Failed to save service"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{service ? "Edit service" : "Add service"}</DialogTitle>
          <DialogDescription>Category and basis drive how the costing engine prices this line.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div>
            <Label>Details (optional — long description shown on the client quotation; the name stays the short title)</Label>
            <Textarea
              rows={3}
              value={form.details}
              onChange={(e) => setForm({ ...form, details: e.target.value })}
              placeholder="e.g. Zvartnots Airport · Victory Park · Cascade Complex"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
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
              <Label>Pricing basis</Label>
              <Select value={form.basis} onValueChange={(v) => setForm({ ...form, basis: v })}>
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
            <div>
              <Label>
                Capacity{" "}
                {form.basis === "CAPACITY_BLOCK" ? (
                  <span className={badgeStatusTextStyles.danger}>(required — people per group)</span>
                ) : (
                  "(optional)"
                )}
              </Label>
              <Input
                type="number"
                min={1}
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                disabled={form.basis !== "CAPACITY_BLOCK"}
                required={form.basis === "CAPACITY_BLOCK"}
              />
            </div>
            <div>
              <Label>Language (optional)</Label>
              <Input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
            </div>
            <div>
              <Label>Duration variant (optional)</Label>
              <Select
                value={form.durationVariant || NONE}
                onValueChange={(v) => setForm({ ...form, durationVariant: v === NONE ? "" : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {DURATION_VARIANTS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {d.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Supplier (optional)</Label>
              <SupplierSelect value={form.supplierId} onChange={(v) => setForm({ ...form, supplierId: v })} suppliers={suppliers} />
            </div>
          </div>
          <div>
            <Label>Weekdays (shared departures only; all unchecked = every day)</Label>
            <WeekdayPicker value={form.weekdays} onChange={(v) => setForm({ ...form, weekdays: v })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : service ? "Save changes" : "Create service"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Hotel product create/edit dialog
// ---------------------------------------------------------------------------

interface HotelFormState {
  name: string;
  city: string;
  country: string;
  stars: string;
  kind: string;
  roomType: string;
  capacityAdults: string;
  capacityChildren: string;
  capacityTotal: string;
  beds: string;
  extraBedAllowed: boolean;
  cotAllowed: boolean;
  boardOptions: string; // comma-separated in the UI, JSON array on the model
  supplierId: string;
  active: boolean;
}

const EMPTY_HOTEL_FORM: HotelFormState = {
  name: "",
  city: "",
  country: "AM",
  stars: "",
  kind: "ROOM",
  roomType: "",
  capacityAdults: "2",
  capacityChildren: "0",
  capacityTotal: "2",
  beds: "",
  extraBedAllowed: false,
  cotAllowed: false,
  boardOptions: "",
  supplierId: "",
  active: true,
};

function hotelToForm(h: HotelProductView): HotelFormState {
  return {
    name: h.name,
    city: h.city ?? "",
    country: h.country,
    stars: h.stars != null ? String(h.stars) : "",
    kind: h.kind,
    roomType: h.roomType ?? "",
    capacityAdults: String(h.capacityAdults),
    capacityChildren: String(h.capacityChildren),
    capacityTotal: String(h.capacityTotal),
    beds: h.beds ?? "",
    extraBedAllowed: h.extraBedAllowed,
    cotAllowed: h.cotAllowed,
    boardOptions: parseJson<string[]>(h.boardOptions, []).join(", "),
    supplierId: h.supplier?.id ?? "",
    active: h.active,
  };
}

function HotelDialog({
  hotel,
  open,
  onOpenChange,
  onSaved,
  suppliers,
}: {
  hotel: HotelProductView | null; // null = create
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  suppliers: SupplierOption[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<HotelFormState>(EMPTY_HOTEL_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(hotel ? hotelToForm(hotel) : EMPTY_HOTEL_FORM);
  }, [open, hotel]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      city: form.city.trim() || null,
      country: form.country.trim().toUpperCase() || "AM",
      stars: intOrNull(form.stars),
      kind: form.kind,
      roomType: form.roomType.trim() || null,
      capacityAdults: intOrNull(form.capacityAdults) ?? 2,
      capacityChildren: intOrNull(form.capacityChildren) ?? 0,
      capacityTotal: intOrNull(form.capacityTotal) ?? 2,
      beds: form.beds.trim() || null,
      extraBedAllowed: form.extraBedAllowed,
      cotAllowed: form.cotAllowed,
      boardOptions: form.boardOptions
        .split(",")
        .map((b) => b.trim().toUpperCase())
        .filter(Boolean),
      supplierId: form.supplierId || null,
      active: form.active,
    };
    try {
      if (hotel) {
        await axios.patch(`/api/travel/catalog/hotels/${hotel.id}`, payload);
        toast("Hotel updated", "success");
      } else {
        await axios.post("/api/travel/catalog/hotels", payload);
        toast("Hotel created", "success");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast(apiError(err, "Failed to save hotel"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{hotel ? "Edit hotel" : "Add hotel"}</DialogTitle>
          <DialogDescription>Physical room/unit product. Rates per occupancy are managed on the row's Rates panel.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label>City (optional)</Label>
              <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div>
              <Label>Country</Label>
              <Input
                maxLength={3}
                value={form.country}
                onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })}
                required
              />
            </div>
            <div>
              <Label>Stars (optional)</Label>
              <Input type="number" min={1} max={5} value={form.stars} onChange={(e) => setForm({ ...form, stars: e.target.value })} />
            </div>
            <div>
              <Label>Kind</Label>
              <Select value={form.kind} onValueChange={(v) => setForm({ ...form, kind: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ROOM">Room</SelectItem>
                  <SelectItem value="COTTAGE_UNIT">Cottage / whole unit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Room type (optional)</Label>
              <Input
                placeholder="e.g. Standard / Cottage 2BR"
                value={form.roomType}
                onChange={(e) => setForm({ ...form, roomType: e.target.value })}
              />
            </div>
            <div>
              <Label>Beds (optional)</Label>
              <Input placeholder="e.g. 1 DBL + 1 SGL" value={form.beds} onChange={(e) => setForm({ ...form, beds: e.target.value })} />
            </div>
            <div>
              <Label>Capacity adults</Label>
              <Input
                type="number"
                min={0}
                value={form.capacityAdults}
                onChange={(e) => setForm({ ...form, capacityAdults: e.target.value })}
                required
              />
            </div>
            <div>
              <Label>Capacity children</Label>
              <Input
                type="number"
                min={0}
                value={form.capacityChildren}
                onChange={(e) => setForm({ ...form, capacityChildren: e.target.value })}
                required
              />
            </div>
            <div>
              <Label>Capacity total</Label>
              <Input
                type="number"
                min={1}
                value={form.capacityTotal}
                onChange={(e) => setForm({ ...form, capacityTotal: e.target.value })}
                required
              />
            </div>
            <div>
              <Label>Supplier (optional)</Label>
              <SupplierSelect value={form.supplierId} onChange={(v) => setForm({ ...form, supplierId: v })} suppliers={suppliers} />
            </div>
          </div>
          <div>
            <Label>Board options (comma-separated, e.g. BB, HB, FB)</Label>
            <Input value={form.boardOptions} onChange={(e) => setForm({ ...form, boardOptions: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.extraBedAllowed}
                onChange={(e) => setForm({ ...form, extraBedAllowed: e.target.checked })}
              />
              Extra bed allowed
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.cotAllowed} onChange={(e) => setForm({ ...form, cotAllowed: e.target.checked })} />
              Cot allowed
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : hotel ? "Save changes" : "Create hotel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** Compact summary of a hotel's rate validity bands, Excel "Remark" style. */
function validitySummary(rates: RateView[]): string {
  const bands = new Set<string>();
  for (const r of rates) {
    bands.add(validityLabel(r.validFrom, r.validTo));
  }
  if (bands.size === 0) return "No rates";
  const list = Array.from(bands);
  return list.length <= 2 ? list.join(" · ") : `${list[0]} · ${list[1]} +${list.length - 2}`;
}

function HotelsTab() {
  const { toast } = useToast();
  const [hotels, setHotels] = useState<HotelProductView[]>([]);
  const [q, setQ] = useState("");
  const suppliers = useSuppliers();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hotelDialog, setHotelDialog] = useState<{ open: boolean; hotel: HotelProductView | null }>({
    open: false,
    hotel: null,
  });
  const [rateDialog, setRateDialog] = useState<{ open: boolean; hotelId: string; rate: RateView | null }>({
    open: false,
    hotelId: "",
    rate: null,
  });
  const [deleteHotel, setDeleteHotel] = useState<HotelProductView | null>(null);

  // Admins manage active flags here, so the list must include inactive rows.
  const load = useCallback(() => {
    axios
      .get(`/api/travel/catalog/hotels?q=${encodeURIComponent(q)}&includeInactive=true`)
      .then((res) => setHotels(res.data))
      .catch((err) => toast(apiError(err, "Failed to load hotels"), "error"));
  }, [q, toast]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  // Reordering a search-filtered subset is meaningless — drag is search-gated.
  const reorderDisabled = q.trim() !== "";
  const reorder = useCatalogReorder(hotels, setHotels, "/api/travel/catalog/hotels/reorder");

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Hotel products</CardTitle>
          <CardDescription>
            Hotels and whole-unit cottages with price brackets per occupancy. Rates are verified on the Rates tab.
          </CardDescription>
        </div>
        <Button onClick={() => setHotelDialog({ open: true, hotel: null })}>Add hotel</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Input placeholder="Search hotels..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          {reorderDisabled && (
            <p className="text-xs text-muted-foreground">Drag to reorder is disabled while a search filter is active.</p>
          )}
        </div>
        <DndContext
          sensors={reorder.sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setExpandedId(null)}
          onDragEnd={reorder.onDragEnd}
        >
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 px-2"><span className="sr-only">Reorder</span></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>City</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Boards</TableHead>
                  <TableHead>Price validity</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SortableContext items={hotels.map((h) => h.id)} strategy={verticalListSortingStrategy}>
                  {hotels.map((h) => (
                    <Fragment key={h.id}>
                      <SortableTableRow id={h.id} disabled={reorderDisabled} className={h.active ? "" : "text-muted-foreground"}>
                        <TableCell>{hotelDisplayName(h)}</TableCell>
                        <TableCell>{h.city ?? "—"}</TableCell>
                        <TableCell>{h.country}</TableCell>
                        <TableCell>{h.kind}</TableCell>
                        <TableCell>
                          {h.capacityAdults}A/{h.capacityChildren}C (max {h.capacityTotal})
                          {h.extraBedAllowed ? " +EB" : ""}
                        </TableCell>
                        <TableCell>{parseJson<string[]>(h.boardOptions, []).join(", ") || "—"}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{validitySummary(h.rates)}</TableCell>
                        <TableCell>{h.supplier?.name ?? "—"}</TableCell>
                        <TableCell><Badge variant={h.active ? "success" : "neutral"}>{h.active ? "Active" : "Inactive"}</Badge></TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => setHotelDialog({ open: true, hotel: h })}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setExpandedId(expandedId === h.id ? null : h.id)}
                            >
                              {expandedId === h.id ? "Hide rates" : `Rates (${h.rates.length})`}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setDeleteHotel(h)}>
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </SortableTableRow>
                      {expandedId === h.id && (
                        <TableRow>
                          <TableCell colSpan={11} className="bg-muted/30 px-4 py-3">
                            <div className="mb-2 flex items-center justify-between">
                              <p className="text-xs font-medium text-muted-foreground">
                                Price brackets — {h.name}
                                {h.city ? ` (${h.city})` : ""}
                              </p>
                              <Button
                                size="sm"
                                onClick={() => setRateDialog({ open: true, hotelId: h.id, rate: null })}
                              >
                                Add rate
                              </Button>
                            </div>
                            <RateTable
                              rates={h.rates}
                              productType="HOTEL"
                              onEdit={(r) => setRateDialog({ open: true, hotelId: h.id, rate: r })}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </SortableContext>
                {hotels.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="py-6 text-center text-muted-foreground">
                      No hotels found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DndContext>
      </CardContent>
      <HotelDialog
        hotel={hotelDialog.hotel}
        open={hotelDialog.open}
        onOpenChange={(open) => setHotelDialog((d) => ({ ...d, open }))}
        onSaved={load}
        suppliers={suppliers}
      />
      <RateDialog
        productType="HOTEL"
        productId={rateDialog.hotelId}
        rate={rateDialog.rate}
        open={rateDialog.open}
        onOpenChange={(open) => setRateDialog((d) => ({ ...d, open }))}
        onSaved={load}
      />
      {deleteHotel && (
        <ConfirmDeleteDialog
          title={`Delete hotel ${hotelDisplayName(deleteHotel)}?`}
          description={`Deletes the hotel and its ${deleteHotel.rates.length} rate version(s). Blocked while any itinerary stay references it. This cannot be undone.`}
          endpoint={`/api/travel/catalog/hotels/${deleteHotel.id}`}
          successMessage={`Deleted hotel ${deleteHotel.name}`}
          onClose={() => setDeleteHotel(null)}
          onDeleted={() => {
            setDeleteHotel(null);
            load();
          }}
        />
      )}
    </Card>
  );
}

function ServicesTab() {
  const { toast } = useToast();
  const [services, setServices] = useState<ServiceProductView[]>([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("ALL");
  const suppliers = useSuppliers();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [serviceDialog, setServiceDialog] = useState<{ open: boolean; service: ServiceProductView | null }>({
    open: false,
    service: null,
  });
  const [rateDialog, setRateDialog] = useState<{ open: boolean; serviceId: string; rate: RateView | null }>({
    open: false,
    serviceId: "",
    rate: null,
  });
  const [deleteService, setDeleteService] = useState<ServiceProductView | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (category !== "ALL") params.set("category", category);
    params.set("includeInactive", "true");
    axios
      .get(`/api/travel/catalog/services?${params.toString()}`)
      .then((res) => setServices(res.data))
      .catch((err) => toast(apiError(err, "Failed to load services"), "error"));
  }, [q, category, toast]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  // Search-gated like hotels; with a category filter the reorder posts just
  // that subset and the server keeps the rest of the catalog in place.
  const reorderDisabled = q.trim() !== "";
  const reorder = useCatalogReorder(services, setServices, "/api/travel/catalog/services/reorder");

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Service products</CardTitle>
          <CardDescription>Tours, tickets, meals, guides and other priced services with their rate versions.</CardDescription>
        </div>
        <Button onClick={() => setServiceDialog({ open: true, service: null })}>Add service</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input placeholder="Search services..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All categories</SelectItem>
                {COST_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {reorderDisabled && (
            <p className="text-xs text-muted-foreground">Drag to reorder is disabled while a search filter is active.</p>
          )}
        </div>
        <DndContext
          sensors={reorder.sensors}
          collisionDetection={closestCenter}
          onDragStart={() => setExpandedId(null)}
          onDragEnd={reorder.onDragEnd}
        >
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8 px-2"><span className="sr-only">Reorder</span></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Basis</TableHead>
                  <TableHead>Weekdays</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <SortableContext items={services.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {services.map((s) => (
                    <Fragment key={s.id}>
                      <SortableTableRow id={s.id} disabled={reorderDisabled} className={s.active ? "" : "text-muted-foreground"}>
                        <TableCell>
                          {s.name}
                          {s.details && <p className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">{s.details}</p>}
                        </TableCell>
                        <TableCell>{s.category.replace(/_/g, " ")}</TableCell>
                        <TableCell>{basisLabel(s.basis, s.capacity)}</TableCell>
                        <TableCell className="text-xs">{weekdaysSummary(s.weekdays)}</TableCell>
                        <TableCell>{s.supplier?.name ?? "—"}</TableCell>
                        <TableCell><Badge variant={s.active ? "success" : "neutral"}>{s.active ? "Active" : "Inactive"}</Badge></TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button size="sm" variant="outline" onClick={() => setServiceDialog({ open: true, service: s })}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                            >
                              {expandedId === s.id ? "Hide rates" : `Rates (${s.rates.length})`}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setDeleteService(s)}>
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </SortableTableRow>
                      {expandedId === s.id && (
                        <TableRow>
                          <TableCell colSpan={8} className="bg-muted/30 px-4 py-3">
                            <div className="mb-2 flex items-center justify-between">
                              <p className="text-xs font-medium text-muted-foreground">Rates — {s.name}</p>
                              <Button
                                size="sm"
                                onClick={() => setRateDialog({ open: true, serviceId: s.id, rate: null })}
                              >
                                Add rate
                              </Button>
                            </div>
                            <RateTable
                              rates={s.rates}
                              productType="SERVICE"
                              onEdit={(r) => setRateDialog({ open: true, serviceId: s.id, rate: r })}
                            />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </SortableContext>
                {services.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                      No services found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </DndContext>
      </CardContent>
      <ServiceDialog
        service={serviceDialog.service}
        open={serviceDialog.open}
        onOpenChange={(open) => setServiceDialog((d) => ({ ...d, open }))}
        onSaved={load}
        suppliers={suppliers}
      />
      <RateDialog
        productType="SERVICE"
        productId={rateDialog.serviceId}
        rate={rateDialog.rate}
        open={rateDialog.open}
        onOpenChange={(open) => setRateDialog((d) => ({ ...d, open }))}
        onSaved={load}
      />
      {deleteService && (
        <ConfirmDeleteDialog
          title={`Delete service ${deleteService.name}?`}
          description={`Deletes the service and its ${deleteService.rates.length} rate version(s). Blocked while any itinerary service line references it. This cannot be undone.`}
          endpoint={`/api/travel/catalog/services/${deleteService.id}`}
          successMessage={`Deleted service ${deleteService.name}`}
          onClose={() => setDeleteService(null)}
          onDeleted={() => {
            setDeleteService(null);
            load();
          }}
        />
      )}
    </Card>
  );
}

function RatesTab() {
  const { toast } = useToast();
  const [rates, setRates] = useState<RateView[]>([]);
  const [status, setStatus] = useState("NEEDS_REVIEW");
  const [productType, setProductType] = useState("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== "ALL") params.set("status", status);
    if (productType !== "ALL") params.set("productType", productType);
    axios
      .get(`/api/travel/catalog/rates?${params.toString()}`)
      .then((res) => setRates(res.data))
      .catch((err) => toast(apiError(err, "Failed to load rates"), "error"));
  }, [status, productType, toast]);

  useEffect(load, [load]);

  async function patchRate(id: string, nextStatus: string) {
    setBusyId(id);
    try {
      await axios.patch(`/api/travel/catalog/rates/${id}`, { status: nextStatus });
      toast(`Rate ${nextStatus.toLowerCase().replace(/_/g, " ")}`, "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to update rate"), "error");
    } finally {
      setBusyId(null);
    }
  }

  function productName(r: RateView): string {
    return r.hotelProduct?.name ?? r.vehicleType?.name ?? r.serviceProduct?.name ?? "—";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rate versions</CardTitle>
        <CardDescription>Rates are archived, never deleted — they are the evidence trail for snapshots.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {RATE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={productType} onValueChange={setProductType}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              <SelectItem value="HOTEL">Hotel</SelectItem>
              <SelectItem value="VEHICLE">Vehicle</SelectItem>
              <SelectItem value="SERVICE">Service</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Occ / board</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Evidence</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rates.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {productName(r)}
                    <span className="ml-1 text-xs text-muted-foreground">({r.productType})</span>
                  </TableCell>
                  <TableCell>
                    {r.occupancy ?? "—"}
                    {r.board ? ` / ${r.board}` : ""}
                  </TableCell>
                  <TableCell>{r.productType === "VEHICLE" ? "—" : (r.vehicleType?.name ?? "—")}</TableCell>
                  <TableCell className="text-right">{r.amount == null ? "TBC" : money(r.amount, r.currency)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{validityLabel(r.validFrom, r.validTo)}</TableCell>
                  <TableCell className="text-xs">{r.evidenceRef ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.notes ?? "—"}</TableCell>
                  <TableCell>
                    <StateBadge value={r.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {r.status === "NEEDS_REVIEW" && (
                        <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => patchRate(r.id, "VERIFIED")}>
                          Verify
                        </Button>
                      )}
                      {r.status !== "ARCHIVED" && (
                        <Button size="sm" variant="ghost" disabled={busyId === r.id} onClick={() => patchRate(r.id, "ARCHIVED")}>
                          Archive
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                    No rates for this filter.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function FxPolicyTab() {
  const { toast } = useToast();
  const [fx, setFx] = useState<FxVersionView[]>([]);
  const [policies, setPolicies] = useState<PolicyView[]>([]);
  const [deleteFx, setDeleteFx] = useState<FxVersionView | null>(null);
  const [deletePolicy, setDeletePolicy] = useState<PolicyView | null>(null);
  const [fxForm, setFxForm] = useState({ currency: "", amdPerUnit: "", effectiveFrom: "" });
  const [policyForm, setPolicyForm] = useState({
    name: "",
    type: "MARKUP_ON_COST",
    rate: "",
    minProfit: "",
    minProfitCurrency: "USD",
    feeFraction: "",
    roundingIncrement: "1",
    quoteCurrency: "USD",
    allowBelowFloorException: false,
  });

  const load = useCallback(() => {
    axios.get("/api/travel/fx").then((res) => setFx(res.data)).catch(() => toast("Failed to load FX", "error"));
    axios
      .get("/api/travel/policies")
      .then((res) => setPolicies(res.data))
      .catch(() => toast("Failed to load policies", "error"));
  }, [toast]);

  useEffect(load, [load]);

  async function addFx(e: React.FormEvent) {
    e.preventDefault();
    // DateField has no `required` attribute — guard the date before POST.
    if (!fxForm.effectiveFrom) {
      toast("Pick an effective-from date", "error");
      return;
    }
    try {
      await axios.post("/api/travel/fx", fxForm);
      toast("FX rate added", "success");
      setFxForm({ currency: "", amdPerUnit: "", effectiveFrom: "" });
      load();
    } catch (err) {
      toast(apiError(err, "Failed to add FX rate"), "error");
    }
  }

  async function addPolicy(e: React.FormEvent) {
    e.preventDefault();
    try {
      await axios.post("/api/travel/policies", {
        ...policyForm,
        // The form speaks percent (what admins quote); the API/engine store
        // decimal fractions — convert at the boundary.
        rate: policyForm.rate ? String(Number(policyForm.rate) / 100) : null,
        minProfit: policyForm.minProfit || null,
        minProfitCurrency: policyForm.minProfit ? policyForm.minProfitCurrency : null,
        feeFraction: policyForm.feeFraction ? String(Number(policyForm.feeFraction) / 100) : null,
      });
      toast("Policy version created (inactive until activated)", "success");
      setPolicyForm({ ...policyForm, name: "", rate: "", minProfit: "", feeFraction: "" });
      load();
    } catch (err) {
      toast(apiError(err, "Failed to create policy"), "error");
    }
  }

  async function activatePolicy(id: string) {
    try {
      await axios.put("/api/travel/settings", { activatePolicyId: id });
      toast("Policy activated", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to activate policy"), "error");
    }
  }

  return (
    // Stacked full-width: the policies table is too wide to share a row with FX.
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>FX rates</CardTitle>
          <CardDescription>AMD per 1 unit, by effective date. AMD = 1 implicitly.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={addFx} className="grid gap-2 sm:grid-cols-4">
            <Input
              placeholder="USD"
              maxLength={3}
              value={fxForm.currency}
              onChange={(e) => setFxForm({ ...fxForm, currency: e.target.value.toUpperCase() })}
              required
            />
            <Input
              placeholder="AMD per unit"
              value={fxForm.amdPerUnit}
              onChange={(e) => setFxForm({ ...fxForm, amdPerUnit: e.target.value })}
              required
            />
            <DateField
              value={fxForm.effectiveFrom}
              onChange={(iso) => setFxForm({ ...fxForm, effectiveFrom: iso })}
            />
            <Button type="submit">Add</Button>
          </form>
          <div className="max-h-[400px] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Currency</TableHead>
                  <TableHead>AMD per unit</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {fx.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium">{f.currency}</TableCell>
                    <TableCell>{f.amdPerUnit}</TableCell>
                    <TableCell>{formatDisplayDate(f.effectiveFrom)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => setDeleteFx(f)}>
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pricing policies</CardTitle>
          <CardDescription>Exactly one policy is active; creating adds a new inactive version.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={addPolicy} className="grid gap-2 sm:grid-cols-3">
            <Input
              placeholder="Name"
              value={policyForm.name}
              onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })}
              required
            />
            <Select value={policyForm.type} onValueChange={(v) => setPolicyForm({ ...policyForm, type: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MARKUP_ON_COST">Markup on cost</SelectItem>
                <SelectItem value="GROSS_MARGIN_ON_SALES">Gross margin on sales</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Rate % (e.g. 16)"
              value={policyForm.rate}
              onChange={(e) => setPolicyForm({ ...policyForm, rate: e.target.value })}
            />
            <Input
              placeholder="Min profit per traveler (excl. infants)"
              value={policyForm.minProfit}
              onChange={(e) => setPolicyForm({ ...policyForm, minProfit: e.target.value })}
            />
            <Input
              placeholder="Fee % (optional)"
              value={policyForm.feeFraction}
              onChange={(e) => setPolicyForm({ ...policyForm, feeFraction: e.target.value })}
            />
            <Input
              placeholder="Rounding increment"
              value={policyForm.roundingIncrement}
              onChange={(e) => setPolicyForm({ ...policyForm, roundingIncrement: e.target.value })}
            />
            <Input
              placeholder="Quote currency"
              maxLength={3}
              value={policyForm.quoteCurrency}
              onChange={(e) => setPolicyForm({ ...policyForm, quoteCurrency: e.target.value.toUpperCase() })}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={policyForm.allowBelowFloorException}
                onChange={(e) => setPolicyForm({ ...policyForm, allowBelowFloorException: e.target.checked })}
              />
              Allow below-floor exception
            </label>
            <Button type="submit">Create policy</Button>
          </form>
          <div className="max-h-[400px] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rate</TableHead>
                  <TableHead>Min profit / traveler</TableHead>
                  <TableHead>Fee</TableHead>
                  <TableHead>Quote ccy</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {policies.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-xs">{p.type.replace(/_/g, " ")}</TableCell>
                    <TableCell>{fractionPercent(p.rate)}</TableCell>
                    <TableCell>{p.minProfit ? money(p.minProfit, p.minProfitCurrency) : "—"}</TableCell>
                    <TableCell>{fractionPercent(p.feeFraction)}</TableCell>
                    <TableCell>{p.quoteCurrency}</TableCell>
                    <TableCell>{p.active ? <StateBadge value="READY" /> : "—"}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {!p.active && (
                          <Button size="sm" variant="outline" onClick={() => activatePolicy(p.id)}>
                            Activate
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setDeletePolicy(p)}>
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {deleteFx && (
        <ConfirmDeleteDialog
          title={`Delete FX rate for ${deleteFx.currency}?`}
          description={`Deletes the rate ${deleteFx.amdPerUnit} AMD per ${deleteFx.currency} effective ${formatDisplayDate(deleteFx.effectiveFrom)}. Blocked when it is the currency's last rate. This cannot be undone.`}
          endpoint={`/api/travel/fx/${deleteFx.id}`}
          successMessage={`Deleted FX rate for ${deleteFx.currency}`}
          onClose={() => setDeleteFx(null)}
          onDeleted={() => {
            setDeleteFx(null);
            load();
          }}
        />
      )}
      {deletePolicy && (
        <ConfirmDeleteDialog
          title={`Delete policy ${deletePolicy.name}?`}
          description="Deletes this policy version. The active policy and the last remaining policy cannot be deleted. This cannot be undone."
          endpoint={`/api/travel/policies/${deletePolicy.id}`}
          successMessage={`Deleted policy ${deletePolicy.name}`}
          onClose={() => setDeletePolicy(null)}
          onDeleted={() => {
            setDeletePolicy(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function ImportsTab() {
  const { toast } = useToast();
  const [batches, setBatches] = useState<ImportBatchView[]>([]);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRowView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    axios
      .get("/api/travel/imports")
      .then((res) => setBatches(res.data))
      .catch((err) => toast(apiError(err, "Failed to load imports"), "error"));
  }, [toast]);

  async function openRows(batchId: string) {
    if (openBatch === batchId) {
      setOpenBatch(null);
      return;
    }
    try {
      const res = await axios.get(`/api/travel/imports/${batchId}`);
      setRows(res.data.rows);
      setSelected(new Set());
      setOpenBatch(batchId);
    } catch (err) {
      toast(apiError(err, "Failed to load batch rows"), "error");
    }
  }

  async function verifySelected(batchId: string) {
    try {
      const res = await axios.post(`/api/travel/imports/${batchId}/verify`, { rowIds: Array.from(selected) });
      toast(`Verified ${res.data.verified} row(s)`, "success");
      const refreshed = await axios.get(`/api/travel/imports/${batchId}`);
      setRows(refreshed.data.rows);
      setSelected(new Set());
      const list = await axios.get("/api/travel/imports");
      setBatches(list.data);
    } catch (err) {
      toast(apiError(err, "Verify failed"), "error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import batches</CardTitle>
        <CardDescription>Staged workbook imports. Select staged rows to verify them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Created</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{b.fileName}</TableCell>
                  <TableCell>
                    <StateBadge value={b.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {b.rowCount} total —{" "}
                    {Object.entries(b.counts)
                      .map(([s, n]) => `${s}: ${n}`)
                      .join(", ")}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(b.createdAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openRows(b.id)}>
                      {openBatch === b.id ? "Hide rows" : "Rows"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {batches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No import batches.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {openBatch && (
          <div className="rounded-lg border p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Batch rows</p>
              <Button size="sm" disabled={selected.size === 0} onClick={() => verifySelected(openBatch)}>
                Verify selected ({selected.size})
              </Button>
            </div>
            <div className="max-h-[400px] overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead>Entity</TableHead>
                    <TableHead>Source ref</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Issue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        {r.status === "STAGED" && (
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(r.id);
                              else next.delete(r.id);
                              setSelected(next);
                            }}
                          />
                        )}
                      </TableCell>
                      <TableCell>{r.entityType}</TableCell>
                      <TableCell className="font-mono text-xs">{r.sourceRef}</TableCell>
                      <TableCell>
                        <StateBadge value={r.status} />
                      </TableCell>
                      <TableCell className="text-xs">{r.issueText ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgenciesTab() {
  const { toast } = useToast();
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [form, setForm] = useState({ shortCode: "", name: "", contactName: "", contactEmail: "", contactPhone: "" });

  const load = useCallback(() => {
    axios
      .get("/api/travel/agencies")
      .then((res) => setAgencies(res.data))
      .catch((err) => toast(apiError(err, "Failed to load agencies"), "error"));
  }, [toast]);

  useEffect(load, [load]);

  async function addAgency(e: React.FormEvent) {
    e.preventDefault();
    try {
      await axios.post("/api/travel/agencies", {
        shortCode: form.shortCode.toUpperCase(),
        name: form.name,
        contactName: form.contactName || null,
        contactEmail: form.contactEmail || null,
        contactPhone: form.contactPhone || null,
      });
      toast("Agency created", "success");
      setForm({ shortCode: "", name: "", contactName: "", contactEmail: "", contactPhone: "" });
      load();
    } catch (err) {
      toast(apiError(err, "Failed to create agency"), "error");
    }
  }

  async function toggleActive(a: Agency) {
    try {
      await axios.patch(`/api/travel/agencies/${a.id}`, { active: !a.active });
      toast(a.active ? "Agency deactivated" : "Agency activated", "success");
      load();
    } catch (err) {
      toast(apiError(err, "Failed to update agency"), "error");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Agencies</CardTitle>
        <CardDescription>Short codes feed the package code prefix.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={addAgency} className="grid gap-2 sm:grid-cols-6">
          <Input
            placeholder="SHORTCODE"
            value={form.shortCode}
            onChange={(e) => setForm({ ...form, shortCode: e.target.value.toUpperCase() })}
            required
          />
          <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <Input placeholder="Contact name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          <Input
            placeholder="Contact email"
            type="email"
            value={form.contactEmail}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
          />
          <Input placeholder="Contact phone" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
          <Button type="submit">Create agency</Button>
        </form>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agencies.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono">{a.shortCode}</TableCell>
                  <TableCell>{a.name}</TableCell>
                  <TableCell className="text-xs">
                    {[a.contactName, a.contactEmail, a.contactPhone].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                  <TableCell><Badge variant={a.active ? "success" : "neutral"}>{a.active ? "Active" : "Inactive"}</Badge></TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => toggleActive(a)}>
                      {a.active ? "Deactivate" : "Activate"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
