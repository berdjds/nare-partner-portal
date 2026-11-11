"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** The happy-path stages of a request, in order. Statuses outside it are shown as a note, never as progress. */
const STAGES = [
  ["DRAFT", "Draft"],
  ["PENDING_VALIDATION", "In validation"],
  ["APPROVED", "Approved"],
  ["ISSUED", "Quote issued"],
] as const;

const AFTER_ISSUE = new Set(["ACCEPTED"]);
const OFF_PATH: Record<string, string> = {
  CHANGES_REQUESTED: "Changes requested: back with the advisor",
  DECLINED: "Declined",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

export function stageIndexOf(status: string): number {
  if (AFTER_ISSUE.has(status)) return STAGES.length; // everything done
  if (status === "CHANGES_REQUESTED") return 0; // returned to the draft stage
  const i = STAGES.findIndex(([key]) => key === status);
  return i; // -1 for off-path terminal statuses
}

/** Read-only progress indicator for the request workflow; the status badge stays the source of truth. */
export default function RequestProgress({ status }: { status: string }) {
  const current = stageIndexOf(status);
  const note = OFF_PATH[status];
  return (
    <div>
      <ol aria-label="Request progress" className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {STAGES.map(([key, label], i) => {
          const done = current > i;
          const here = current === i;
          return (
            <li key={key} aria-current={here ? "step" : undefined} className="flex shrink-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className={cn("h-0.5 w-5 rounded-full sm:w-8", done || here ? "bg-brand" : "bg-border")} />}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
                  done && "bg-brand text-white",
                  here && "bg-plum text-white",
                  !done && !here && "bg-muted text-muted-foreground",
                )}
              >
                {done && <Check className="h-3 w-3" aria-hidden="true" />}
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      {note && <p className="mt-2 text-xs font-medium text-muted-foreground">{note}</p>}
    </div>
  );
}
