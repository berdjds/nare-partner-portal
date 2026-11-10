"use client";

import { reviewItems, type ReviewLine } from "@/lib/travel/review-flags";

/** Surfaces what the template recalculation flagged, so conflicts are never silent. */
export default function TemplateReviewNotice({ lines }: { lines: ReviewLine[] }) {
  const items = reviewItems(lines);
  if (items.length === 0) return null;
  const review = items.filter((i) => i.kind === "review");
  return (
    <section aria-labelledby="tpl-review-title" className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm" data-testid="template-review">
      <h2 id="tpl-review-title" className="font-medium">
        {review.length > 0 ? `${review.length} template ${review.length === 1 ? "item needs" : "items need"} review` : "Template items not applicable"}
      </h2>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {items.map((i) => (
          <li key={i.id}><strong>{i.label}</strong>{i.date ? ` (${i.date})` : ""}: {i.reasons.join("; ")}.</li>
        ))}
      </ul>
    </section>
  );
}
