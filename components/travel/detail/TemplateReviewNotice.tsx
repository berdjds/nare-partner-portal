"use client";

import { useState } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { reviewItems, type ReviewLine } from "@/lib/travel/review-flags";

/** Surfaces what the template recalculation flagged, so conflicts are never silent. */
export default function TemplateReviewNotice({ lines, failed = false, requestId, revision, onRetried }: {
  lines: ReviewLine[];
  /** The request was created from a template but applying its rules failed. */
  failed?: boolean;
  requestId?: string;
  revision?: number;
  onRetried?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const items = reviewItems(lines);
  const review = items.filter((i) => i.kind === "review");

  async function retry() {
    if (!requestId || revision === undefined) return;
    setBusy(true); setError("");
    try {
      await axios.post(`/api/travel/requests/${requestId}/recalculate`, { expectedRevision: revision });
      window.history.replaceState(null, "", window.location.pathname);
      onRetried?.();
    } catch { setError("Could not apply the template rules. Refresh the page and try again."); }
    finally { setBusy(false); }
  }

  return (
    <>
      {failed && (
        <section role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="template-rules-failed">
          <p className="font-medium">The template rules were not applied to this request.</p>
          <p className="mt-1">Quantities and flags may be out of date until they are applied again.</p>
          <div className="mt-2 flex items-center gap-3">
            <Button type="button" size="sm" onClick={retry} disabled={busy || !requestId}>{busy ? "Applying…" : "Apply template rules"}</Button>
            {error && <span className="text-xs">{error}</span>}
          </div>
        </section>
      )}
      {items.length > 0 && (
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
      )}
    </>
  );
}
