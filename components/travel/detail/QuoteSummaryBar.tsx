"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { badgeStatusTextStyles } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { StateBadge, money } from "../utils";
import type { DetailContext } from "./RequestDetail";

/**
 * Always-visible price summary between the header and the tabs. Editable
 * versions show the live preview (recalculated on every save via the revision
 * signal); submitted versions show the persisted snapshot results — no API
 * call, since an approved price must not move with later edits.
 */
export default function QuoteSummaryBar({ ctx }: { ctx: DetailContext }) {
  const { version } = ctx;
  const currency = ctx.resultCurrency;

  return (
    <Card className="mb-4">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 py-3">
        <CardTitle className="text-base">Quote summary</CardTitle>
        <div className="flex items-center gap-2">
          {ctx.quoteLoading && <span className="text-xs text-muted-foreground">Updating prices…</span>}
          {ctx.canEditVersion && (
            <Button variant="outline" size="sm" onClick={ctx.recalculateQuote} disabled={ctx.quoteLoading}>
              Recalculate
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1 pt-0">
        {version.scenarios.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add hotels and services to see prices.</p>
        ) : (
          version.scenarios.map((sc) => {
            const r = ctx.quoteResults?.get(sc.id) ?? null;
            const blockers = r ? r.issues.filter((i) => i.severity === "BLOCKER").length : 0;
            const warnings = r ? r.issues.length - blockers : 0;
            return (
              <div key={sc.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="font-medium">{sc.label}</span>
                {r ? (
                  <>
                    <StateBadge value={r.valid ? "READY" : "FAILED"} />
                    {/* An invalid result's sell is the engine's bare-cost
                        fallback — meaningless next to FAILED, so hide it. */}
                    <span>
                      Sell:{" "}
                      <strong className="[font-variant-numeric:tabular-nums]">
                        {r.valid ? money(r.sell, currency) : "—"}
                      </strong>
                    </span>
                    {r.valid && r.perPayingPerson && (
                      <span className="text-muted-foreground">
                        per paying person: {money(r.perPayingPerson, currency)}
                      </span>
                    )}
                    {blockers > 0 && (
                      <span className={badgeStatusTextStyles.danger}>
                        {blockers} blocker{blockers === 1 ? "" : "s"}
                      </span>
                    )}
                    {warnings > 0 && (
                      <span className={badgeStatusTextStyles.warning}>
                        {warnings} warning{warnings === 1 ? "" : "s"}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    {ctx.quoteLoading ? "Calculating…" : "not calculated"}
                  </span>
                )}
              </div>
            );
          })
        )}
        {ctx.quoteError && (
          <div className={cn("flex items-center gap-2 pt-1 text-xs", badgeStatusTextStyles.danger)}>
            <span>{ctx.quoteError} — showing the last known prices.</span>
            <Button variant="outline" size="sm" onClick={ctx.recalculateQuote}>
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
