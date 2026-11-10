"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { versionLabel } from "@/lib/travel/contracts";
import { formatDateTime } from "../utils";
import type { DetailContext } from "./RequestDetail";

interface TimelineEntry {
  time: string;
  label: string;
  detail?: string;
}

export default function HistoryTab({ ctx }: { ctx: DetailContext }) {
  const { detail } = ctx;
  const entries: TimelineEntry[] = [];

  entries.push({ time: detail.createdAt, label: "Request created", detail: detail.packageCode });

  for (const v of detail.versions) {
    entries.push({ time: v.createdAt, label: `${versionLabel(v.versionNo)} created` });
    if (v.submittedAt) entries.push({ time: v.submittedAt, label: `${versionLabel(v.versionNo)} submitted` });
    if (v.decidedAt) {
      entries.push({
        time: v.decidedAt,
        label: `${versionLabel(v.versionNo)} decided → ${v.status}`,
        detail: v.decisionReason ?? undefined,
      });
    }
    for (const d of v.decisions) {
      entries.push({
        time: d.createdAt,
        label: `Review decision: ${d.action.replace(/_/g, " ")} on ${versionLabel(v.versionNo)}`,
        detail: `${d.reason ? `${d.reason} · ` : ""}snapshot ${d.snapshotHash.slice(0, 12)}… · actor ${d.actorId.slice(0, 8)}…`,
      });
    }
  }

  for (const a of detail.assignments) {
    entries.push({
      time: a.createdAt,
      label: `Assigned to ${a.validator.name || a.validator.email}`,
      detail: a.dueAt ? `due ${formatDateTime(a.dueAt)}` : undefined,
    });
    if (a.deactivatedAt) {
      entries.push({
        time: a.deactivatedAt,
        label: `Assignment of ${a.validator.name || a.validator.email} ended`,
      });
    }
  }

  entries.sort((a, b) => (a.time < b.time ? 1 : -1));

  return (
    <Card>
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Decisions, assignments and version lifecycle, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-4 border-s ps-5">
          {entries.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="absolute -start-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-primary/40 bg-card" />
              <span className="font-medium">{e.label}</span>
              <span className="ms-2 text-xs text-muted-foreground">{formatDateTime(e.time)}</span>
              {e.detail && <p className="text-xs text-muted-foreground">{e.detail}</p>}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
