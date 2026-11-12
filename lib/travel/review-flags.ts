/** Human wording for the template review flags stored on service lines (Phase 2). Pure. */

export const FLAG_TEXT: Record<string, string> = {
  BELOW_MIN: "fewer participants than the minimum for this item",
  ABOVE_MAX: "more participants than the maximum for this item",
  WEEKDAY_UNAVAILABLE: "the date is not one of this item's departure days",
  MANUAL_OVERRIDE_KEPT: "edited by hand, so the template rule was not applied",
};

export interface ReviewLine {
  id: string;
  label: string;
  date: string | null;
  reviewFlag?: string | null;
  ruleInactive?: boolean;
}
export interface ReviewItem {
  id: string;
  label: string;
  date: string | null;
  kind: "review" | "inactive";
  reasons: string[];
}

export function reviewItems(lines: ReviewLine[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const l of lines) {
    const reasons = (l.reviewFlag ?? "").split(",").map((c) => c.trim()).filter(Boolean).map((c) => FLAG_TEXT[c] ?? "needs review");
    if (reasons.length) out.push({ id: l.id, label: l.label, date: l.date, kind: "review", reasons });
    else if (l.ruleInactive) out.push({ id: l.id, label: l.label, date: l.date, kind: "inactive", reasons: ["not applicable for the current travellers, so it is not charged"] });
  }
  return out;
}
