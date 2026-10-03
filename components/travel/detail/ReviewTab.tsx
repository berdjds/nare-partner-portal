"use client";

import { Fragment, useEffect, useState } from "react";
import axios from "axios";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { badgeStatusStyles, badgeStatusTextStyles } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { versionLabel, type EngineIssue, type ScenarioResult } from "@/lib/travel/contracts";
import { StateBadge, StatusBadge, apiError, formatDateTime, money, parseJson, shortHash } from "../utils";
import TraceTable from "../TraceTable";
import DocumentsTab from "./DocumentsTab";
import type { TravelUser } from "../types";
import type { DetailContext } from "./RequestDetail";

export default function ReviewTab({ ctx }: { ctx: DetailContext }) {
  const { toast } = useToast();
  const { detail, version } = ctx;
  const [busy, setBusy] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [belowFloorReason, setBelowFloorReason] = useState("");
  const [reviewAction, setReviewAction] = useState<"APPROVE" | "REQUEST_CHANGES" | "REJECT" | null>(null);
  const [reviewReason, setReviewReason] = useState("");
  const [outcomeAction, setOutcomeAction] = useState<"ACCEPTED" | "DECLINED" | "EXPIRED" | null>(null);
  const [outcomeScenarioId, setOutcomeScenarioId] = useState("");
  const [submitOpen, setSubmitOpen] = useState(false);

  // Opening the submit dialog re-runs the preview so the amounts the advisor
  // confirms are the latest saved content, not a stale earlier calculation.
  const recalculateQuote = ctx.recalculateQuote;
  useEffect(() => {
    if (submitOpen) recalculateQuote();
  }, [submitOpen, recalculateQuote]);

  const isAssignedValidator = detail.currentValidatorId === ctx.userId;
  const canSubmit =
    (ctx.isOwner || ctx.isAdmin) && ctx.isLatestVersion && ["DRAFT", "CHANGES_REQUESTED"].includes(version.status);
  // Self-validation is allowed: the assigned validator reviews, even when
  // they also submitted the version (v0.10.0).
  // W2: review/issue buttons hide when the user lacks the permission the
  // server enforces on the corresponding workflow action.
  const canReview =
    version.status === "PENDING_VALIDATION" && isAssignedValidator && ctx.permissions.includes("travel.review");
  const canIssue =
    (ctx.isOwner || ctx.isAdmin) && version.status === "APPROVED" && ctx.permissions.includes("travel.issue");
  const canOutcome = (ctx.isOwner || ctx.isAdmin) && version.status === "ISSUED";
  const canAssign = (ctx.isOwner || ctx.isAdmin) && ["DRAFT", "CHANGES_REQUESTED"].includes(detail.status);

  // Summary rows: the persisted snapshot result first; on an editable version
  // without one, fall back to the live quote preview (v0.15.2) so the
  // calculation trace is visible BEFORE submitting binds a snapshot.
  const scenarioRows = version.scenarios.map((sc) => {
    const persisted = parseJson<ScenarioResult | null>(sc.resultJson, null);
    const result = persisted ?? ctx.quoteResults?.get(sc.id) ?? null;
    return { id: sc.id, result, isPreview: persisted === null && result !== null };
  });
  const shownRows = scenarioRows.filter(
    (r): r is { id: string; result: ScenarioResult; isPreview: boolean } => r.result !== null,
  );
  const showingPreview = shownRows.some((r) => r.isPreview);
  const allIssues: (EngineIssue & { scenarioLabel?: string })[] = shownRows.flatMap((r) =>
    r.result.issues.map((i) => ({ ...i, scenarioLabel: r.result.label })),
  );
  const belowFloor = allIssues.some((i) => i.code === "BELOW_FLOOR");

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit() {
    await run(async () => {
      try {
        const res = await axios.post(`/api/travel/requests/${detail.id}/submit`);
        toast(`Submitted — snapshot ${shortHash(res.data.hash)}`, "success");
        setSubmitOpen(false);
        ctx.refresh();
      } catch (err: any) {
        if (err?.response?.data?.code === "VALIDATOR_NOT_ASSIGNED") {
          toast("Assign a validator before submitting", "error");
          setSubmitOpen(false);
          setAssignOpen(true);
        } else {
          toast(apiError(err, "Submit failed"), "error");
        }
      }
    });
  }

  async function handleReview() {
    if (!reviewAction || !version.snapshot) return;
    await run(async () => {
      try {
        await axios.post(`/api/travel/versions/${version.id}/review`, {
          action: reviewAction,
          reason: reviewReason || null,
          snapshotHash: version.snapshot!.hash,
        });
        toast(`Decision recorded: ${reviewAction.replace(/_/g, " ")}`, "success");
        setReviewAction(null);
        setReviewReason("");
        ctx.refresh();
      } catch (err: any) {
        if (err?.response?.data?.code === "SNAPSHOT_STALE") {
          toast("The version changed since this page loaded — refreshed. Review again.", "error");
          setReviewAction(null);
          ctx.refresh();
        } else {
          toast(apiError(err, "Review failed"), "error");
        }
      }
    });
  }

  async function handleIssue() {
    await run(async () => {
      try {
        const res = await axios.post(`/api/travel/versions/${version.id}/issue`, {
          belowFloorExceptionReason: belowFloorReason || null,
        });
        const renderState: string | undefined = res.data.document?.renderState;
        if (renderState === "FAILED") {
          toast("Issued, but PDF generation failed — see the Documents section below", "error");
        } else if (res.data.idempotent) {
          toast("Already issued — showing existing document", "success");
        } else {
          toast("Quotation issued", "success");
        }
        setIssueOpen(false);
        ctx.refresh();
      } catch (err) {
        toast(apiError(err, "Issue failed"), "error");
      }
    });
  }

  async function handleOutcome() {
    if (!outcomeAction) return;
    await run(async () => {
      try {
        await axios.post(`/api/travel/versions/${version.id}/outcome`, {
          outcome: outcomeAction,
          scenarioId: outcomeAction === "ACCEPTED" ? outcomeScenarioId : null,
        });
        toast(`Outcome recorded: ${outcomeAction}`, "success");
        setOutcomeAction(null);
        ctx.refresh();
      } catch (err) {
        toast(apiError(err, "Failed to record outcome"), "error");
      }
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>
                {versionLabel(version.versionNo)} — <StatusBadge status={version.status} />
                {showingPreview && (
                  <span className={cn("ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-semibold", badgeStatusStyles.warning)}>
                    LIVE PREVIEW
                  </span>
                )}
              </CardTitle>
              <CardDescription>
                {version.submittedAt && <>Submitted {formatDateTime(version.submittedAt)} · </>}
                {version.decidedAt && (
                  <>
                    Decided {formatDateTime(version.decidedAt)}
                    {version.decisionReason ? ` — ${version.decisionReason}` : ""} ·{" "}
                  </>
                )}
                Snapshot: <span className="font-mono">{shortHash(version.snapshot?.hash)}</span>
                {version.snapshot && <> · engine {version.snapshot.engineVersion}</>}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {showingPreview && (
            <p className={cn("rounded-md border px-3 py-2 text-xs", badgeStatusStyles.warning)}>
              Live preview of current content — not submitted yet; submitting binds this calculation.
            </p>
          )}
          {shownRows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-3">Scenario</TableHead>
                    <TableHead>Valid</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Sell</TableHead>
                    <TableHead className="text-right">Profit</TableHead>
                    <TableHead className="text-right">Margin %</TableHead>
                    <TableHead className="text-right">Per paying person</TableHead>
                    <TableHead className="pr-3 text-right">Issues</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownRows.map((row) => {
                    const r = row.result;
                    const trace = ctx.quoteTraces?.get(row.id);
                    return (
                      <Fragment key={row.id}>
                        <TableRow>
                          <TableCell className="pl-3 font-medium">{r.label}</TableCell>
                          <TableCell>{r.valid ? "yes" : "no"}</TableCell>
                          {/* Costing columns: absent from advisor-redacted results.
                              Sell-side figures are the engine's bare-cost fallback
                              when invalid — meaningless, so show "—" (v0.15.1). */}
                          <TableCell className="text-right">
                            {r.totals ? money(r.totals.costQuote, ctx.resultCurrency) : "—"}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {r.valid ? money(r.sell, ctx.resultCurrency) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.valid && r.profit != null ? money(r.profit, ctx.resultCurrency) : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.valid && r.margin != null ? `${(Number(r.margin) * 100).toFixed(1)}%` : "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {r.valid ? money(r.perPayingPerson, ctx.resultCurrency) : "—"}
                          </TableCell>
                          <TableCell className="pr-3 text-right">{r.issues.length}</TableCell>
                        </TableRow>
                        {trace && trace.length > 0 && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={8} className="bg-muted/30 px-3 py-2">
                              <details>
                                <summary className="flex cursor-pointer select-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                  <ChevronRight className="h-3.5 w-3.5 transition-transform [details[open]_&]:rotate-90" />
                                  Calculation breakdown
                                </summary>
                                <TraceTable rows={trace} className="mt-2 bg-background" />
                              </details>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {allIssues.length > 0 && (
            <ul className="space-y-1">
              {allIssues.map((iss, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <StateBadge value={iss.severity} />
                  <span className="font-mono">{iss.code}</span>
                  {iss.scenarioLabel && <span className="text-muted-foreground">[{iss.scenarioLabel}]</span>}
                  <span>{iss.message}</span>
                </li>
              ))}
            </ul>
          )}
          {shownRows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {ctx.quoteLoading
                ? "Calculating…"
                : "No calculation snapshot yet — submit to calculate and bind one."}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>
            Validator: {detail.validator ? detail.validator.name || detail.validator.email : "not assigned"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {canAssign && (
            <Button variant="outline" onClick={() => setAssignOpen(true)}>
              {detail.validator ? "Change validator" : "Assign validator"}
            </Button>
          )}
          {ctx.isAdmin && detail.validator && (
            <Button variant="outline" onClick={() => setReassignOpen(true)}>
              Reassign (admin)
            </Button>
          )}
          {canSubmit && (
            <Button onClick={() => setSubmitOpen(true)} disabled={busy}>
              {version.status === "CHANGES_REQUESTED" ? "Resubmit for validation" : "Submit for validation"}
            </Button>
          )}
          {canReview && (
            <>
              <Button onClick={() => setReviewAction("APPROVE")} disabled={busy}>
                Approve
              </Button>
              <Button variant="outline" onClick={() => setReviewAction("REQUEST_CHANGES")} disabled={busy}>
                Request changes
              </Button>
              <Button variant="destructive" onClick={() => setReviewAction("REJECT")} disabled={busy}>
                Reject
              </Button>
            </>
          )}
          {canIssue && (
            <Button onClick={() => setIssueOpen(true)} disabled={busy}>
              Issue quotation
            </Button>
          )}
          {canOutcome && (
            <>
              <Button onClick={() => setOutcomeAction("ACCEPTED")} disabled={busy}>
                Client accepted
              </Button>
              <Button variant="outline" onClick={() => setOutcomeAction("DECLINED")} disabled={busy}>
                Client declined
              </Button>
              <Button variant="outline" onClick={() => setOutcomeAction("EXPIRED")} disabled={busy}>
                Expired
              </Button>
            </>
          )}
          {!canSubmit && !canReview && !canIssue && !canOutcome && !canAssign && (
            <p className="text-sm text-muted-foreground">No actions available for your role in the current status.</p>
          )}
        </CardContent>
      </Card>

      <AssignValidatorDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        title={detail.validator ? "Change validator" : "Assign validator"}
        endpoint={`/api/travel/requests/${detail.id}/assignments`}
        selfId={ctx.userId}
        isAdmin={ctx.isAdmin}
        onDone={() => {
          setAssignOpen(false);
          ctx.refresh();
        }}
      />
      <AssignValidatorDialog
        open={reassignOpen}
        onClose={() => setReassignOpen(false)}
        title="Reassign validator"
        endpoint={`/api/travel/requests/${detail.id}/reassign`}
        selfId={ctx.userId}
        isAdmin={ctx.isAdmin}
        onDone={() => {
          setReassignOpen(false);
          ctx.refresh();
        }}
      />

      {/* submit confirmation: the advisor sees the exact amounts first. The
          server allows submitting with blockers (approval is what they block),
          so they are shown as a warning, not a hard stop. */}
      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {version.status === "CHANGES_REQUESTED" ? "Resubmit for validation" : "Submit for validation"}
            </DialogTitle>
            <DialogDescription>
              Confirm these amounts. Submitting binds a snapshot of the current content; any later edit requires a
              new review round.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {version.scenarios.map((sc) => {
              const r = ctx.quoteResults?.get(sc.id) ?? null;
              const trace = ctx.quoteTraces?.get(sc.id);
              const blockers = r ? r.issues.filter((i) => i.severity === "BLOCKER") : [];
              return (
                <div key={sc.id} className="rounded-lg border p-3 text-sm [font-variant-numeric:tabular-nums]">
                  {trace && trace.length > 0 && (
                    <details className="mb-2">
                      <summary className="flex cursor-pointer select-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                        <ChevronRight className="h-3.5 w-3.5 transition-transform [details[open]_&]:rotate-90" />
                        Calculation breakdown
                      </summary>
                      <TraceTable rows={trace} className="mt-2" />
                    </details>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="font-medium">{sc.label}</span>
                    {r ? (
                      <>
                        <StateBadge value={r.valid ? "READY" : "FAILED"} />
                        <span>
                          Sell: <strong>{r.valid ? money(r.sell, ctx.resultCurrency) : "—"}</strong>
                        </span>
                        {r.valid && r.perPayingPerson && (
                          <span className="text-muted-foreground">
                            per paying person: {money(r.perPayingPerson, ctx.resultCurrency)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {ctx.quoteLoading ? "Calculating…" : "not calculated"}
                      </span>
                    )}
                  </div>
                  {blockers.length > 0 && (
                    <ul className="mt-2 space-y-1 border-t pt-2">
                      {blockers.map((iss, i) => (
                        <li key={i} className={cn("flex items-start gap-2 text-xs", badgeStatusTextStyles.danger)}>
                          <span className="font-mono">{iss.code}</span>
                          <span>{iss.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            {version.scenarios.some(
              (sc) => (ctx.quoteResults?.get(sc.id)?.issues ?? []).some((i) => i.severity === "BLOCKER"),
            ) && (
              <p className={cn("text-xs", badgeStatusTextStyles.warning)}>
                Blockers do not prevent submitting, but the validator cannot approve until they are resolved.
              </p>
            )}
            {ctx.quoteError && <p className={cn("text-xs", badgeStatusTextStyles.danger)}>{ctx.quoteError} — amounts may be stale.</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setSubmitOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={busy || ctx.quoteLoading}>
              {busy ? "Submitting..." : "Confirm & submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* review decision dialog */}
      <Dialog open={reviewAction !== null} onOpenChange={(open) => !open && setReviewAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{reviewAction?.replace(/_/g, " ")}</DialogTitle>
            <DialogDescription>
              The decision binds to snapshot <span className="font-mono">{shortHash(version.snapshot?.hash)}</span>.
            </DialogDescription>
          </DialogHeader>
          {reviewAction !== "APPROVE" && (
            <div>
              <Label>Reason (required)</Label>
              <Textarea rows={3} value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={handleReview}
              disabled={busy || (reviewAction !== "APPROVE" && !reviewReason.trim())}
              variant={reviewAction === "REJECT" ? "destructive" : "default"}
            >
              Confirm {reviewAction?.replace(/_/g, " ").toLowerCase()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* issue dialog */}
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue quotation</DialogTitle>
            <DialogDescription>
              Generates the client PDF and moves {versionLabel(version.versionNo)} to ISSUED. Issuing is
              idempotent — repeating it returns the same document.
            </DialogDescription>
          </DialogHeader>
          {belowFloor && (
            <div className="space-y-2">
              <p className={cn("text-sm", badgeStatusTextStyles.warning)}>
                The snapshot is below the pricing floor. Issuing requires a manager (ADMIN) and a recorded
                exception reason.
              </p>
              <Label>Below-floor exception reason</Label>
              <Textarea rows={2} value={belowFloorReason} onChange={(e) => setBelowFloorReason(e.target.value)} />
            </div>
          )}
          <DialogFooter>
            <Button onClick={handleIssue} disabled={busy || (belowFloor && !belowFloorReason.trim())}>
              Confirm issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* outcome dialog */}
      <Dialog open={outcomeAction !== null} onOpenChange={(open) => !open && setOutcomeAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record outcome: {outcomeAction}</DialogTitle>
            <DialogDescription>This is final for {versionLabel(version.versionNo)}.</DialogDescription>
          </DialogHeader>
          {outcomeAction === "ACCEPTED" && (
            <div>
              <Label>Accepted scenario</Label>
              <Select value={outcomeScenarioId} onValueChange={setOutcomeScenarioId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select scenario" />
                </SelectTrigger>
                <SelectContent>
                  {version.scenarios.map((sc) => (
                    <SelectItem key={sc.id} value={sc.id}>
                      {sc.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <DialogFooter>
            <Button onClick={handleOutcome} disabled={busy || (outcomeAction === "ACCEPTED" && !outcomeScenarioId)}>
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Documents live here since the tabs were merged — issuance and its
          artifacts belong to the same review surface. */}
      <DocumentsTab ctx={ctx} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Validator picker. Any active user can be assigned (v0.10.0); the list comes
 * from /api/travel/users/assignable (open to travel actors). If the list
 * fails to load, fall back to manual id entry.
 */
function AssignValidatorDialog({
  open,
  onClose,
  title,
  endpoint,
  selfId,
  isAdmin,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  endpoint: string;
  selfId: string;
  isAdmin: boolean;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [users, setUsers] = useState<TravelUser[] | null>(null);
  const [validatorId, setValidatorId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValidatorId("");
    setDueAt("");
    axios
      .get("/api/travel/users/assignable")
      .then((res) => setUsers(res.data as TravelUser[]))
      .catch(() => setUsers(null));
  }, [open, selfId]);

  async function handleAssign() {
    if (!validatorId) return;
    setBusy(true);
    try {
      await axios.post(endpoint, {
        validatorId,
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      });
      toast("Validator assigned", "success");
      onDone();
    } catch (err) {
      toast(apiError(err, "Assignment failed"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Any active user can be assigned as validator.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {users ? (
            <div>
              <Label>Validator</Label>
              <Select value={validatorId} onValueChange={setValidatorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select validator" />
                </SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name || u.email} ({u.role})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div>
              <Label>Validator user id</Label>
              <Input value={validatorId} onChange={(e) => setValidatorId(e.target.value)} placeholder="cuid…" />
              <p className="mt-1 text-xs text-muted-foreground">
                {isAdmin
                  ? "Could not load the user list."
                  : "Could not load the user list — paste the validator's user id, or ask an admin to assign."}
              </p>
            </div>
          )}
          <div>
            <Label>Due date (optional)</Label>
            <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleAssign} disabled={busy || !validatorId}>
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
