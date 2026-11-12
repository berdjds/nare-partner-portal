/**
 * Deterministic template recalculation plan (B2B cycle 1, Phase 2). Pure: no I/O.
 *
 * Source of truth is the TemplateVersion (daysJson services + their optional
 * strict `rule`). Given the request's travellers and start date, this derives
 *  1. the itinerary days/services the template wants (mergeTemplateDays), and
 *  2. per-line participants / inactive flags / review flags (planLines).
 *
 * Guarantees (all unit-tested): same input -> same output (idempotent: a second
 * run proposes nothing); template-added items are told apart from manual ones by
 * an explicit key + stamp; a hand-edited template line is never overwritten, it is
 * reported as a conflict for review; manual items are never touched.
 */

import { addDays } from "@/lib/travel/engine/dates";
import { evaluateRule, type TemplateRule } from "@/lib/travel/template-rules";
import type { TravelerSetup } from "@/lib/travel/contracts";

export interface TemplateItem {
  key: string;
  dayOffset: number;
  serviceProductId: string;
  vehicleTypeId: string | null;
  label: string;
  quantity: number;
  rule: TemplateRule | null;
}

export const itemKey = (dayOffset: number, productId: string, vehicleTypeId: string | null | undefined) =>
  `${dayOffset}|${productId}|${vehicleTypeId ?? ""}`;

export type ConflictCode =
  | "BELOW_MIN"
  | "ABOVE_MAX"
  | "WEEKDAY_UNAVAILABLE"
  | "MANUAL_OVERRIDE_KEPT"
  | "QUANTITY_MANUAL_KEPT"
  | "REMOVED_FROM_TEMPLATE_KEPT"
  | "STAYS_NEED_REVIEW"
  | "ROOMS_NEED_REVIEW";

export interface PlanConflict {
  key: string;
  label: string;
  code: ConflictCode;
  detail: string;
}

/** Template items of a TemplateVersion's parsed days; duplicates of (day, product, vehicle) collapse, first wins. */
export function itemsFromTemplateDays(
  days: Array<{
    dayOffset: number;
    services?: Array<{ serviceProductId?: string | null; label: string; quantity?: number | null; vehicleTypeId?: string | null; rule?: TemplateRule | null }> | null;
  }>,
): TemplateItem[] {
  const out = new Map<string, TemplateItem>();
  for (const d of days) {
    for (const s of d.services ?? []) {
      if (!s.serviceProductId) continue; // free-text labels are not catalog items: nothing to price or derive
      const key = itemKey(d.dayOffset, s.serviceProductId, s.vehicleTypeId);
      if (out.has(key)) continue;
      out.set(key, {
        key,
        dayOffset: d.dayOffset,
        serviceProductId: s.serviceProductId,
        vehicleTypeId: s.vehicleTypeId ?? null,
        label: s.label,
        quantity: s.quantity ?? 1,
        rule: s.rule ?? null,
      });
    }
  }
  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// 1. Days
// ---------------------------------------------------------------------------

export interface DayService {
  serviceProductId?: string | null;
  label: string;
  details?: string | null;
  vehicleTypeId?: string | null;
  quantity?: number | null;
}
export interface Day {
  dayOffset: number;
  date: string;
  narrative?: string | null;
  overnightCity?: string | null;
  services?: DayService[] | null;
}

export interface LineEditInfo {
  /** The line carries a hand edit (participants differ from the last derived value, or a rate override). */
  edited: boolean;
}

export interface MergeInput {
  currentDays: Day[];
  /** Items of the template the request was built from (null = unknown: ownership is adopted by key). */
  prevItems: TemplateItem[] | null;
  newItems: TemplateItem[];
  newTemplateDays: Array<{ dayOffset: number; narrative?: string | null; overnightCity?: string | null }>;
  startDate: string;
  /** keyed by itemKey of the CURRENT lines; absent = no line yet */
  lineEdits: Map<string, LineEditInfo>;
}

export function mergeTemplateDays(input: MergeInput): { days: Day[]; conflicts: PlanConflict[] } {
  const { currentDays, prevItems, newItems, newTemplateDays, startDate, lineEdits } = input;
  const prevByKey = new Map((prevItems ?? []).map((i) => [i.key, i]));
  const newByKey = new Map(newItems.map((i) => [i.key, i]));
  const conflicts: PlanConflict[] = [];

  const byOffset = new Map<number, Day>();
  for (const d of currentDays) byOffset.set(d.dayOffset, { ...d, services: [...(d.services ?? [])] });
  for (const t of newTemplateDays) {
    if (!byOffset.has(t.dayOffset)) {
      byOffset.set(t.dayOffset, { dayOffset: t.dayOffset, date: addDays(startDate, t.dayOffset), narrative: t.narrative ?? null, overnightCity: t.overnightCity ?? null, services: [] });
    }
  }

  for (const day of Array.from(byOffset.values())) {
    const kept: DayService[] = [];
    const seen = new Set<string>();
    for (const svc of day.services ?? []) {
      const key = svc.serviceProductId ? itemKey(day.dayOffset, svc.serviceProductId, svc.vehicleTypeId) : null;
      if (!key) { kept.push(svc); continue; } // free-text service: manual, untouched
      const wanted = newByKey.get(key);
      const wasTemplate = prevByKey.has(key) || (prevItems === null && wanted !== undefined);
      if (wanted) {
        if (seen.has(key)) continue; // duplicate collapses like the line sync does
        seen.add(key);
        const prevQty = prevByKey.get(key)?.quantity ?? wanted.quantity;
        const current = svc.quantity ?? 1;
        if (wasTemplate && current !== prevQty && current !== wanted.quantity) {
          conflicts.push({ key, label: wanted.label, code: "QUANTITY_MANUAL_KEPT", detail: `quantity ${current} was edited by hand; the template says ${wanted.quantity}` });
          kept.push(svc);
        } else {
          kept.push({ ...svc, quantity: wasTemplate ? wanted.quantity : current });
        }
      } else if (wasTemplate) {
        // Item left the template. Remove it unless a person has edited its line.
        if (lineEdits.get(key)?.edited) {
          const gone = prevByKey.get(key);
          conflicts.push({ key, label: gone?.label ?? svc.label, code: "REMOVED_FROM_TEMPLATE_KEPT", detail: "no longer in the template, kept because it was edited by hand" });
          kept.push(svc);
        }
      } else {
        kept.push(svc); // manual catalog service: never touched
      }
    }
    for (const item of newItems) {
      if (item.dayOffset !== day.dayOffset || seen.has(item.key)) continue;
      kept.push({ serviceProductId: item.serviceProductId, label: item.label, vehicleTypeId: item.vehicleTypeId, quantity: item.quantity });
    }
    day.services = kept;
    day.date = addDays(startDate, day.dayOffset);
  }
  const days = Array.from(byOffset.values()).sort((a, b) => a.dayOffset - b.dayOffset);
  return { days, conflicts };
}

// ---------------------------------------------------------------------------
// 2. Lines
// ---------------------------------------------------------------------------

export interface LineState {
  id: string;
  label: string;
  serviceProductId: string | null;
  date: string | null;
  vehicleTypeId: string | null;
  participants: number | null;
  ruleInactive: boolean;
  origin: string | null;
  templateKey: string | null;
  derivedJson: string | null;
  reviewFlag: string | null;
  overrideRate: string | null;
  unitRate?: string | null;
}

export interface LineUpdate {
  id: string;
  data: {
    origin: "TEMPLATE";
    templateKey: string;
    participants: number | null;
    ruleInactive: boolean;
    derivedJson: string;
    reviewFlag: string | null;
  };
}

export interface LinePlan {
  updates: LineUpdate[];
  conflicts: PlanConflict[];
  /** Lines the template governs, for the response. */
  governed: number;
}

function parseDerived(json: string | null): { participants: number | null; inactive: boolean } | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return { participants: typeof v.participants === "number" ? v.participants : null, inactive: Boolean(v.inactive) };
  } catch {
    return null;
  }
}

/** A line was edited by hand when it no longer matches what the last derivation wrote. */
export function lineEditInfo(line: Pick<LineState, "participants" | "ruleInactive" | "derivedJson" | "origin" | "overrideRate"> & { unitRate?: string | null }): LineEditInfo {
  const derived = parseDerived(line.derivedJson);
  if (line.origin === "TEMPLATE" && derived) {
    return { edited: line.participants !== derived.participants || line.ruleInactive !== derived.inactive };
  }
  // Legacy / unstamped line: nothing records who set its values, so a participants value (which a
  // catalog-linked line only has when a person set it) is treated as a hand edit and kept. Rates are
  // never derived here, so a typed or overridden rate does not block participants derivation; the
  // orchestrator separately protects rate-bearing lines from being removed on a template switch.
  return { edited: line.participants !== null };
}

export function planLines(input: { items: TemplateItem[]; lines: LineState[]; travelers: TravelerSetup; startDate: string }): LinePlan {
  const { items, lines, travelers, startDate } = input;
  const conflicts: PlanConflict[] = [];
  const updates: LineUpdate[] = [];
  const used = new Set<string>();
  let governed = 0;

  for (const item of items) {
    const date = addDays(startDate, item.dayOffset);
    // The line's DATE is the truth after a re-date (the line sync moves lines between days that
    // share a product), so match on the date first; an older key stamp is restamped below.
    const sameSlot = (l: LineState) => l.serviceProductId === item.serviceProductId && l.date === date && (l.vehicleTypeId ?? null) === item.vehicleTypeId;
    const line =
      lines.find((l) => !used.has(l.id) && l.templateKey === item.key && sameSlot(l)) ??
      lines.find((l) => !used.has(l.id) && (l.templateKey === null || l.templateKey !== item.key) && sameSlot(l)) ??
      lines.find((l) => !used.has(l.id) && l.templateKey === item.key);
    if (!line) continue;
    used.add(line.id);
    governed += 1;

    const ev = evaluateRule(item.rule, travelers, date);
    for (const c of ev.conflicts) conflicts.push({ key: item.key, label: item.label, code: c.code, detail: c.detail });
    const flag = ev.conflicts.length ? ev.conflicts.map((c) => c.code).sort().join(",") : null;

    const edit = lineEditInfo(line);
    if (edit.edited) {
      // Stamp what the rule WOULD derive, so the difference to the hand-set value stays visible on every run.
      const wouldDerive = JSON.stringify({ participants: ev.participants, inactive: !ev.active });
      conflicts.push({ key: item.key, label: item.label, code: "MANUAL_OVERRIDE_KEPT", detail: "participants were edited by hand; the template rule was not applied" });
      const wantFlag = [flag, "MANUAL_OVERRIDE_KEPT"].filter(Boolean).join(",") || null;
      if (line.reviewFlag !== wantFlag || line.templateKey !== item.key || line.origin !== "TEMPLATE") {
        updates.push({ id: line.id, data: { origin: "TEMPLATE", templateKey: item.key, participants: line.participants, ruleInactive: line.ruleInactive, derivedJson: line.origin === "TEMPLATE" && line.derivedJson ? line.derivedJson : wouldDerive, reviewFlag: wantFlag } });
      }
      continue;
    }

    const derivedJson = JSON.stringify({ participants: ev.participants, inactive: !ev.active });
    const same =
      line.origin === "TEMPLATE" && line.templateKey === item.key && line.participants === ev.participants &&
      line.ruleInactive === !ev.active && line.derivedJson === derivedJson && line.reviewFlag === flag;
    if (!same) {
      updates.push({ id: line.id, data: { origin: "TEMPLATE", templateKey: item.key, participants: ev.participants, ruleInactive: !ev.active, derivedJson, reviewFlag: flag } });
    }
  }
  return { updates, conflicts, governed };
}
