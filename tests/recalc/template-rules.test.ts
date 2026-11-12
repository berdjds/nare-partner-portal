/**
 * Phase 2: the template rule vocabulary (pure). Every rule here is backed by
 * workbook evidence (see doc/b2b-cycle-1/PHASE-2.md): traveller categories
 * (Tour Leader / Guide lines), shared-departure weekdays ("Wed-Fri-Sun"),
 * group minimum/maximum. Anything else is an owner decision, not a rule.
 */
import { describe, expect, it } from "vitest";
import { categoryCounts, evaluateRule, isoWeekday, ruleSchema } from "@/lib/travel/template-rules";
import type { TravelerSetup } from "@/lib/travel/contracts";

const T = (o: Partial<TravelerSetup> = {}): TravelerSetup => ({
  adults: 2, children: 0, infants: 0, paying: 2, complimentary: 0, leaders: 0, staff: 0, ...o,
});

describe("ruleSchema", () => {
  it("accepts the vocabulary and rejects unknown keys, empty lists and min > max", () => {
    expect(ruleSchema.safeParse({ appliesTo: ["leader"], minParticipants: 1, maxParticipants: 3, weekdays: [3, 5, 7] }).success).toBe(true);
    expect(ruleSchema.safeParse({}).success).toBe(true);
    expect(ruleSchema.safeParse({ appliesTo: [] }).success).toBe(false);
    expect(ruleSchema.safeParse({ appliesTo: ["pensioner"] }).success).toBe(false);
    expect(ruleSchema.safeParse({ discount: 0.5 }).success).toBe(false); // strict: no invented rules
    expect(ruleSchema.safeParse({ minParticipants: 5, maxParticipants: 2 }).success).toBe(false);
    expect(ruleSchema.safeParse({ weekdays: [0] }).success).toBe(false);
    expect(ruleSchema.safeParse({ weekdays: [8] }).success).toBe(false);
  });
});

describe("categoryCounts", () => {
  it("splits children into child (older than the infant limit) and infant; infants are a subset of children", () => {
    expect(categoryCounts(T({ adults: 2, children: 3, infants: 1, paying: 5, leaders: 1, staff: 2, complimentary: 1 }))).toEqual({
      adult: 2, child: 2, infant: 1, complimentary: 1, leader: 1, staff: 2,
    });
  });
  it("never goes negative on inconsistent input (infants > children)", () => {
    expect(categoryCounts(T({ children: 1, infants: 3 })).child).toBe(0);
  });
});

describe("evaluateRule", () => {
  it("no rule: participants unspecified (engine default = paying), active, no conflicts", () => {
    expect(evaluateRule(undefined, T(), "2026-10-07")).toEqual({ participants: null, active: true, conflicts: [] });
  });
  it("appliesTo sums the named categories only", () => {
    const t = T({ adults: 4, children: 2, infants: 1, paying: 6, leaders: 1, staff: 2, complimentary: 1 });
    expect(evaluateRule({ appliesTo: ["leader"] }, t, null).participants).toBe(1);
    expect(evaluateRule({ appliesTo: ["leader", "staff"] }, t, null).participants).toBe(3);
    expect(evaluateRule({ appliesTo: ["adult", "child"] }, t, null).participants).toBe(5);
    expect(evaluateRule({ appliesTo: ["infant"] }, t, null).participants).toBe(1);
    expect(evaluateRule({ appliesTo: ["complimentary"] }, t, null).participants).toBe(1);
  });
  it("zero eligible travellers: the line is inactive (not charged), without a conflict", () => {
    expect(evaluateRule({ appliesTo: ["leader"], minParticipants: 2 }, T({ leaders: 0 }), null)).toEqual({ participants: 0, active: false, conflicts: [] });
  });
  it("all travellers zero: nothing applies", () => {
    const zero = T({ adults: 0, paying: 0 });
    expect(evaluateRule({ appliesTo: ["adult"] }, zero, null).active).toBe(false);
  });
  it("min/max are inclusive boundaries and only flag, never remove", () => {
    const r = { minParticipants: 2, maxParticipants: 6 };
    for (const [paying, codes] of [[1, ["BELOW_MIN"]], [2, []], [6, []], [7, ["ABOVE_MAX"]]] as const) {
      const out = evaluateRule(r, T({ adults: paying, paying }), null);
      expect(out.conflicts.map((c) => c.code)).toEqual(codes);
      expect(out.active).toBe(true);
    }
  });
  it("min/max measure the rule's own participants when appliesTo is set", () => {
    expect(evaluateRule({ appliesTo: ["child"], minParticipants: 2 }, T({ children: 1, infants: 0, paying: 3 }), null).conflicts.map((c) => c.code)).toEqual(["BELOW_MIN"]);
  });
  it("weekday rule flags a date outside the departure days (ISO 1=Mon..7=Sun)", () => {
    expect(isoWeekday("2026-10-07")).toBe(3); // Wednesday
    expect(isoWeekday("2026-10-11")).toBe(7); // Sunday
    const r = { weekdays: [3, 5, 7] };
    expect(evaluateRule(r, T(), "2026-10-07").conflicts).toEqual([]);
    expect(evaluateRule(r, T(), "2026-10-08").conflicts.map((c) => c.code)).toEqual(["WEEKDAY_UNAVAILABLE"]);
    expect(evaluateRule(r, T(), null).conflicts).toEqual([]); // no date, nothing to judge
  });
  it("is deterministic: same input, same output; category order does not matter", () => {
    const a = evaluateRule({ appliesTo: ["staff", "leader"] }, T({ leaders: 1, staff: 1 }), null);
    const b = evaluateRule({ appliesTo: ["leader", "staff"] }, T({ leaders: 1, staff: 1 }), null);
    expect(a).toEqual(b);
  });
});
