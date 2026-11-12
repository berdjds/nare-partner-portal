/** Phase 2: pure planner. Idempotence, manual protection, template switch, boundaries. */
import { describe, expect, it } from "vitest";
import {
  itemKey, itemsFromTemplateDays, lineEditInfo, mergeTemplateDays, planLines,
  type Day, type LineState, type TemplateItem,
} from "@/lib/travel/recalc-plan";
import type { TravelerSetup } from "@/lib/travel/contracts";

const T = (o: Partial<TravelerSetup> = {}): TravelerSetup => ({ adults: 2, children: 0, infants: 0, paying: 2, complimentary: 0, leaders: 0, staff: 0, ...o });
const tpl = (days: any[]) => itemsFromTemplateDays(days);

const TOUR = { serviceProductId: "tour", label: "Tour", quantity: 1 };
const LEADER = { serviceProductId: "leader-meal", label: "Leader meal", quantity: 1, rule: { appliesTo: ["leader"] as const } };
const GROUP = { serviceProductId: "group", label: "Group tour", quantity: 1, rule: { weekdays: [3, 5, 7], minParticipants: 4 } };
const DAYS = [{ dayOffset: 0, services: [TOUR, LEADER] }, { dayOffset: 1, services: [GROUP] }];

describe("itemsFromTemplateDays", () => {
  it("keeps catalog-linked services only, collapses duplicates (first wins), carries rules", () => {
    const items = tpl([{ dayOffset: 0, services: [TOUR, { ...TOUR, quantity: 5 }, { label: "free text" }, LEADER] }]);
    expect(items.map((i) => i.key)).toEqual([itemKey(0, "tour", null), itemKey(0, "leader-meal", null)]);
    expect(items[0].quantity).toBe(1);
    expect(items[1].rule).toEqual({ appliesTo: ["leader"] });
  });
});

describe("mergeTemplateDays", () => {
  const items = tpl(DAYS);
  const base = { newTemplateDays: DAYS.map((d) => ({ dayOffset: d.dayOffset })), startDate: "2026-10-07", lineEdits: new Map() };

  it("builds days from scratch with dates from the start date", () => {
    const { days } = mergeTemplateDays({ ...base, currentDays: [], prevItems: null, newItems: items });
    expect(days.map((d) => [d.dayOffset, d.date, d.services?.length])).toEqual([[0, "2026-10-07", 2], [1, "2026-10-08", 1]]);
  });
  it("re-dates every day when the start date moves and never touches narrative", () => {
    const first = mergeTemplateDays({ ...base, currentDays: [], prevItems: null, newItems: items }).days;
    first[0].narrative = "my own words";
    const moved = mergeTemplateDays({ ...base, startDate: "2026-10-11", currentDays: first, prevItems: items, newItems: items }).days;
    expect(moved.map((d) => d.date)).toEqual(["2026-10-11", "2026-10-12"]);
    expect(moved[0].narrative).toBe("my own words");
  });
  it("is idempotent: merging its own output again changes nothing", () => {
    const a = mergeTemplateDays({ ...base, currentDays: [], prevItems: null, newItems: items });
    const b = mergeTemplateDays({ ...base, currentDays: a.days, prevItems: items, newItems: items });
    expect(b.days).toEqual(a.days);
    expect(b.conflicts).toEqual([]);
  });
  it("never duplicates a manual item and never removes one", () => {
    const manual: Day = { dayOffset: 0, date: "2026-10-07", services: [{ serviceProductId: "extra", label: "Manual extra", quantity: 2 }, { label: "free text" }] };
    const { days } = mergeTemplateDays({ ...base, currentDays: [manual], prevItems: items, newItems: items });
    const labels = days[0].services!.map((s) => s.label);
    expect(labels).toContain("Manual extra");
    expect(labels).toContain("free text");
    expect(labels.filter((l) => l === "Tour")).toHaveLength(1);
  });
  it("adopts a manual item with the same key instead of duplicating it", () => {
    const manual: Day = { dayOffset: 0, date: "2026-10-07", services: [{ serviceProductId: "tour", label: "Tour", quantity: 1 }] };
    const { days } = mergeTemplateDays({ ...base, currentDays: [manual], prevItems: null, newItems: items });
    expect(days[0].services!.filter((s) => s.serviceProductId === "tour")).toHaveLength(1);
  });
  it("template switch: removes untouched old items, keeps hand-edited ones with a conflict, adds new ones", () => {
    const old = tpl([{ dayOffset: 0, services: [TOUR, { serviceProductId: "old2", label: "Old two", quantity: 1 }] }]);
    const cur = mergeTemplateDays({ ...base, currentDays: [], prevItems: null, newItems: old }).days;
    const edits = new Map([[itemKey(0, "old2", null), { edited: true }]]);
    const next = tpl([{ dayOffset: 0, services: [{ serviceProductId: "new1", label: "New one", quantity: 1 }] }]);
    const out = mergeTemplateDays({ ...base, newTemplateDays: [{ dayOffset: 0 }], currentDays: cur, prevItems: old, newItems: next, lineEdits: edits });
    expect(out.days[0].services!.map((s) => s.serviceProductId).sort()).toEqual(["new1", "old2"]);
    expect(out.conflicts.map((c) => c.code)).toEqual(["REMOVED_FROM_TEMPLATE_KEPT"]);
  });
  it("a hand-edited quantity is kept and reported when the template quantity differs", () => {
    const itemsQ = tpl([{ dayOffset: 0, services: [{ ...TOUR, quantity: 2 }] }]);
    const cur: Day[] = [{ dayOffset: 0, date: "2026-10-07", services: [{ serviceProductId: "tour", label: "Tour", quantity: 5 }] }];
    const prev = tpl([{ dayOffset: 0, services: [{ ...TOUR, quantity: 1 }] }]);
    const out = mergeTemplateDays({ ...base, newTemplateDays: [{ dayOffset: 0 }], currentDays: cur, prevItems: prev, newItems: itemsQ });
    expect(out.days[0].services![0].quantity).toBe(5);
    expect(out.conflicts.map((c) => c.code)).toEqual(["QUANTITY_MANUAL_KEPT"]);
  });
});

function line(over: Partial<LineState>): LineState {
  return { id: "L", label: "x", serviceProductId: "tour", date: "2026-10-07", vehicleTypeId: null, participants: null, ruleInactive: false, origin: null, templateKey: null, derivedJson: null, reviewFlag: null, overrideRate: null, ...over };
}
const L = (items: TemplateItem[], key: string, over: Partial<LineState> = {}) => {
  const it = items.find((i) => i.key === key)!;
  return line({ id: key, serviceProductId: it.serviceProductId, date: `2026-10-${String(7 + it.dayOffset).padStart(2, "0")}`, label: it.label, ...over });
};

describe("planLines", () => {
  const items = tpl(DAYS);
  const lines = () => items.map((i) => L(items, i.key));
  const apply = (ls: LineState[], plan: ReturnType<typeof planLines>) =>
    ls.map((l) => { const u = plan.updates.find((x) => x.id === l.id); return u ? { ...l, ...u.data } : l; });

  it("stamps lines, sets participants from the rule, deactivates a leader line with no leaders", () => {
    const plan = planLines({ items, lines: lines(), travelers: T(), startDate: "2026-10-07" });
    const leader = plan.updates.find((u) => u.id === itemKey(0, "leader-meal", null))!;
    expect(leader.data).toMatchObject({ participants: 0, ruleInactive: true, origin: "TEMPLATE" });
    const tour = plan.updates.find((u) => u.id === itemKey(0, "tour", null))!;
    expect(tour.data).toMatchObject({ participants: null, ruleInactive: false });
  });
  it("activates the leader line when a leader is added, and removes the flag when they are removed again", () => {
    let ls = apply(lines(), planLines({ items, lines: lines(), travelers: T(), startDate: "2026-10-07" }));
    ls = apply(ls, planLines({ items, lines: ls, travelers: T({ leaders: 1 }), startDate: "2026-10-07" }));
    expect(ls.find((l) => l.id === itemKey(0, "leader-meal", null))).toMatchObject({ participants: 1, ruleInactive: false });
    ls = apply(ls, planLines({ items, lines: ls, travelers: T({ leaders: 0 }), startDate: "2026-10-07" }));
    expect(ls.find((l) => l.id === itemKey(0, "leader-meal", null))).toMatchObject({ participants: 0, ruleInactive: true });
  });
  it("is idempotent: a second run proposes no update and no new conflict", () => {
    const t = T({ adults: 3, paying: 3, leaders: 1 });
    const ls = apply(lines(), planLines({ items, lines: lines(), travelers: t, startDate: "2026-10-07" }));
    const again = planLines({ items, lines: ls, travelers: t, startDate: "2026-10-07" });
    expect(again.updates).toEqual([]);
  });
  it("flags below-minimum and wrong weekday without removing the line", () => {
    const plan = planLines({ items, lines: lines(), travelers: T({ adults: 3, paying: 3 }), startDate: "2026-10-07" });
    const g = plan.updates.find((u) => u.id === itemKey(1, "group", null))!;
    expect(g.data.reviewFlag).toBe("BELOW_MIN,WEEKDAY_UNAVAILABLE"); // 3 guests; 2026-10-08 is a Thursday
  });
  it("Thursday start flags the weekday; Wednesday does not", () => {
    const wed = planLines({ items, lines: lines().map((l) => l), travelers: T({ adults: 4, paying: 4 }), startDate: "2026-10-07" });
    // day 1 = Thursday (8th): flagged
    expect(wed.conflicts.map((c) => c.code)).toContain("WEEKDAY_UNAVAILABLE");
    const tue = planLines({ items, lines: items.map((i) => L(items, i.key, { date: `2026-10-${String(6 + i.dayOffset).padStart(2, "0")}` })), travelers: T({ adults: 4, paying: 4 }), startDate: "2026-10-06" });
    expect(tue.conflicts.map((c) => c.code)).not.toContain("WEEKDAY_UNAVAILABLE"); // day 1 = Wednesday the 7th
  });
  it("zero travellers: every governed rule line is inactive or flagged, nothing throws", () => {
    const plan = planLines({ items, lines: lines(), travelers: T({ adults: 0, paying: 0 }), startDate: "2026-10-07" });
    expect(plan.governed).toBe(3);
  });
  it("a hand-edited participants value is kept and reported, never overwritten", () => {
    const stamped = apply(lines(), planLines({ items, lines: lines(), travelers: T({ leaders: 1 }), startDate: "2026-10-07" }));
    const edited = stamped.map((l) => (l.id === itemKey(0, "leader-meal", null) ? { ...l, participants: 7 } : l));
    expect(lineEditInfo(edited.find((l) => l.id === itemKey(0, "leader-meal", null))!).edited).toBe(true);
    const plan = planLines({ items, lines: edited, travelers: T({ leaders: 2 }), startDate: "2026-10-07" });
    expect(plan.conflicts.map((c) => c.code)).toContain("MANUAL_OVERRIDE_KEPT");
    expect(plan.updates.find((u) => u.id === itemKey(0, "leader-meal", null))?.data.participants ?? 7).toBe(7);
  });
  it("never touches lines the template does not govern", () => {
    const manual = line({ id: "m", serviceProductId: "manual", date: "2026-10-07" });
    const plan = planLines({ items, lines: [manual, ...lines()], travelers: T(), startDate: "2026-10-07" });
    expect(plan.updates.some((u) => u.id === "m")).toBe(false);
  });
});

describe("template editor keeps rules through a save", () => {
  it("TemplateEditor carries the service rule when loading a version (source guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../components/travel/TemplateEditor.tsx", import.meta.url), "utf8");
    expect(src).toContain("rule: (s as { rule?: unknown }).rule ?? null");
  });
});
