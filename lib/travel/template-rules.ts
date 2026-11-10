/**
 * Template rule vocabulary (B2B cycle 1, Phase 2). Pure: no I/O, no clock.
 *
 * Derived from what the Nare workbook actually does (doc/b2b-cycle-1/PHASE-2.md):
 *  - appliesTo: which traveller categories a line is for. Evidence: Tour Leader
 *    Tickets/Meals/Accommodation and Guide Lunch/Dinner/Overnight lines are charged
 *    for leaders / guides, not for guests; guest lines are charged for paying guests.
 *  - weekdays: shared "Group Tour" departures run on fixed days ("Wed-Fri-Sun").
 *  - minParticipants / maxParticipants: group-size limits; a breach is a conflict
 *    for a human to review, never a silent removal or repricing.
 *
 * Deliberately NOT here (no evidence in the templates; recorded as owner decisions):
 * child/infant discounts or free ages per item, free-ratio rules (1 free per N),
 * optional items, per-item rounding, room allocation from traveller counts.
 * The schema is strict so a template cannot smuggle in an unreviewed rule.
 */

import { z } from "zod";
import type { TravelerSetup } from "@/lib/travel/contracts";

export const TRAVELLER_CATEGORIES = ["adult", "child", "infant", "complimentary", "leader", "staff"] as const;
export type TravellerCategory = (typeof TRAVELLER_CATEGORIES)[number];

export const ruleSchema = z
  .object({
    appliesTo: z.array(z.enum(TRAVELLER_CATEGORIES)).min(1).max(TRAVELLER_CATEGORIES.length).optional(),
    minParticipants: z.number().int().min(0).max(10_000).optional(),
    maxParticipants: z.number().int().min(1).max(10_000).optional(),
    /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  })
  .strict()
  .refine((r) => r.minParticipants === undefined || r.maxParticipants === undefined || r.minParticipants <= r.maxParticipants, {
    message: "minParticipants must not exceed maxParticipants",
    path: ["minParticipants"],
  });
export type TemplateRule = z.infer<typeof ruleSchema>;

export type RuleConflictCode = "BELOW_MIN" | "ABOVE_MAX" | "WEEKDAY_UNAVAILABLE";
export interface RuleConflict {
  code: RuleConflictCode;
  detail: string;
}
export interface RuleEvaluation {
  /** null = the rule does not say; the engine falls back to paying guests. */
  participants: number | null;
  /** false = nobody eligible; the line must not be charged. */
  active: boolean;
  conflicts: RuleConflict[];
}

/** Infants are a subset of children (the 0-12 count), as everywhere else in the module. */
export function categoryCounts(t: TravelerSetup): Record<TravellerCategory, number> {
  const infants = Math.max(0, t.infants);
  return {
    adult: Math.max(0, t.adults),
    child: Math.max(0, t.children - infants),
    infant: infants,
    complimentary: Math.max(0, t.complimentary),
    leader: Math.max(0, t.leaders),
    staff: Math.max(0, t.staff),
  };
}

export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

export function evaluateRule(rule: TemplateRule | null | undefined, travelers: TravelerSetup, date: string | null): RuleEvaluation {
  if (!rule) return { participants: null, active: true, conflicts: [] };
  const counts = categoryCounts(travelers);
  const unique = rule.appliesTo ? Array.from(new Set(rule.appliesTo)) : null;
  const participants = unique ? unique.reduce((sum, c) => sum + counts[c], 0) : null;
  if (participants === 0) return { participants: 0, active: false, conflicts: [] };

  const base = participants ?? Math.max(0, travelers.paying);
  const conflicts: RuleConflict[] = [];
  if (rule.minParticipants !== undefined && base < rule.minParticipants) {
    conflicts.push({ code: "BELOW_MIN", detail: `${base} participant(s), minimum ${rule.minParticipants}` });
  }
  if (rule.maxParticipants !== undefined && base > rule.maxParticipants) {
    conflicts.push({ code: "ABOVE_MAX", detail: `${base} participant(s), maximum ${rule.maxParticipants}` });
  }
  if (rule.weekdays && date && !rule.weekdays.includes(isoWeekday(date))) {
    conflicts.push({ code: "WEEKDAY_UNAVAILABLE", detail: `${date} is not one of the departure days` });
  }
  return { participants, active: true, conflicts };
}
