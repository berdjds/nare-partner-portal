"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import axios from "axios";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { versionLabel } from "@/lib/travel/contracts";
import { nightsBetween, formatDisplayDateRange } from "@/lib/travel/engine/dates";
import { StatusBadge, apiError, money, parseJson } from "../utils";
import type { TravelRequestDetail, VersionDetail } from "../types";
import type { ScenarioResult } from "@/lib/travel/contracts";
import type { TraceRow } from "@/lib/travel/trace-table";
import OverviewTab from "./OverviewTab";
import ItineraryTab from "./ItineraryTab";
import ScenariosTab from "./ScenariosTab";
import ReviewTab from "./ReviewTab";
import HistoryTab from "./HistoryTab";
import QuoteSummaryBar from "./QuoteSummaryBar";
import { useQuotePreview } from "./useQuotePreview";

interface RequestDetailProps {
  requestId: string;
  role: string;
  userId: string;
  permissions: string[];
}

/** Underline-style trigger for page-level tab bars (segmented is the ui default). */
const PAGE_TAB_CLASS =
  "rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none";

export interface DetailContext {
  detail: TravelRequestDetail;
  version: VersionDetail;
  isLatestVersion: boolean;
  role: string;
  userId: string;
  /** W2: permission keys of the signed-in user; tabs hide actions the server
   *  would deny (e.g. travel.review, travel.issue, document downloads). */
  permissions: string[];
  isOwner: boolean;
  isAdmin: boolean;
  /** Settings-level quote currency — fallback only. */
  quoteCurrency: string;
  /** Currency for the selected version's results: version-bound, else settings. */
  resultCurrency: string;
  /** owner/ADMIN and the selected version accepts content edits. */
  canEditVersion: boolean;
  /** owner/ADMIN and the request itself accepts field edits. */
  canEditRequest: boolean;
  /** Scenario id → result: live preview for editable versions, persisted snapshot otherwise. */
  quoteResults: Map<string, ScenarioResult> | null;
  /** Scenario id → calculation breakdown rows (v0.15.0): live preview trace
   *  for editable versions, frozen snapshot trace otherwise. */
  quoteTraces: Map<string, TraceRow[]> | null;
  quoteLoading: boolean;
  quoteError: string | null;
  recalculateQuote: () => void;
  refresh: () => void;
}

export default function RequestDetail({ requestId, role, userId, permissions }: RequestDetailProps) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<TravelRequestDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [quoteCurrency, setQuoteCurrency] = useState("USD");
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [reviseOpen, setReviseOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await axios.get(`/api/travel/requests/${requestId}`);
      const data: TravelRequestDetail = res.data;
      setDetail(data);
      setSelectedVersionId((prev) =>
        prev && data.versions.some((v) => v.id === prev)
          ? prev
          : data.versions[data.versions.length - 1]?.id ?? null,
      );
    } catch (err) {
      toast(apiError(err, "Failed to load request"), "error");
    }
  }, [requestId, toast]);

  useEffect(() => {
    load();
    axios
      .get("/api/travel/settings")
      .then((res) => {
        if (res.data?.activePolicy?.quoteCurrency) setQuoteCurrency(res.data.activePolicy.quoteCurrency);
      })
      .catch(() => null);
  }, [load]);

  const version = useMemo(
    () => detail?.versions.find((v) => v.id === selectedVersionId) ?? detail?.versions[detail.versions.length - 1],
    [detail, selectedVersionId],
  );

  // Computed before the early return so the preview hook can run
  // unconditionally (hooks cannot sit behind the loading guard).
  const editableVersion =
    !!detail &&
    !!version &&
    (detail.ownerId === userId || role === "ADMIN") &&
    ["DRAFT", "CHANGES_REQUESTED"].includes(version.status);
  const preview = useQuotePreview(
    version?.id ?? "",
    detail?.revision ?? 0,
    editableVersion && (version?.scenarios.length ?? 0) > 0,
  );
  // Non-editable versions (and the first moments of an editable one) read the
  // snapshot persisted at submit — the approved price must not move.
  const persistedResults = useMemo(() => {
    if (!version) return null;
    const map = new Map<string, ScenarioResult>();
    for (const sc of version.scenarios) {
      const r = parseJson<ScenarioResult | null>(sc.resultJson, null);
      if (r) map.set(sc.id, r);
    }
    return map;
  }, [version]);
  const quoteResults =
    editableVersion && preview.results.size > 0 ? preview.results : persistedResults;
  const persistedTraces = useMemo(() => {
    if (!version) return null;
    const map = new Map<string, TraceRow[]>();
    for (const sc of version.scenarios) {
      if (sc.traceRows) map.set(sc.id, sc.traceRows);
    }
    return map;
  }, [version]);
  const quoteTraces =
    editableVersion && preview.traces.size > 0 ? preview.traces : persistedTraces;

  if (!detail || !version) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const isOwner = detail.ownerId === userId;
  const isAdmin = role === "ADMIN";
  const latest = detail.versions[detail.versions.length - 1];
  const isLatestVersion = version.id === latest.id;
  const canEditVersion = editableVersion;
  const canEditRequest =
    (isOwner || isAdmin) && ["DRAFT", "CHANGES_REQUESTED"].includes(detail.status) && isLatestVersion;
  const canRevise =
    (isOwner || isAdmin) &&
    ["CHANGES_REQUESTED", "APPROVED", "ISSUED", "REJECTED"].includes(latest.status) &&
    // W2: the server gates createRevision on travel.create (same key as
    // createRequest) — hide the action when the key is missing.
    permissions.includes("travel.create");

  const ctx: DetailContext = {
    detail,
    version,
    isLatestVersion,
    role,
    userId,
    permissions,
    isOwner,
    isAdmin,
    quoteCurrency,
    resultCurrency: version.quoteCurrency ?? quoteCurrency,
    canEditVersion,
    canEditRequest,
    quoteResults,
    quoteTraces,
    quoteLoading: editableVersion ? preview.loading : false,
    quoteError: editableVersion ? preview.error : null,
    recalculateQuote: preview.recalculate,
    refresh: load,
  };

  async function handleNewRevision() {
    if (!detail) return;
    setReviseOpen(false);
    setBusy(true);
    try {
      const res = await axios.post(`/api/travel/requests/${detail.id}/versions`);
      toast(`Created ${versionLabel(res.data.versionNo)}`, "success");
      setSelectedVersionId(res.data.id);
      await load();
    } catch (err) {
      toast(apiError(err, "Failed to create revision"), "error");
    } finally {
      setBusy(false);
    }
  }

  const nights = nightsBetween(detail.startDate, detail.endDate);
  const cmpA = detail.versions.find((v) => v.id === compareA);
  const cmpB = detail.versions.find((v) => v.id === compareB);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1 text-[13px] text-muted-foreground">
        <Link href="/travel" className="transition-colors hover:text-foreground">
          Requests
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        <span className="font-mono text-foreground">{detail.packageCode}</span>
      </nav>
      {/* Sticky request header: identity + version switch stay visible while
          scrolling long itinerary/scenario tabs. top-14 clears the mobile top
          bar; on desktop the sidebar leaves the viewport top free. */}
      <Card className="sticky top-14 z-30 mb-4 lg:top-3">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <CardTitle className="font-mono text-lg">{detail.packageCode}</CardTitle>
                <StatusBadge status={detail.status} />
              </div>
              <p className="text-sm font-medium">{detail.title}</p>
              <p className="text-[13px] text-muted-foreground">
                {detail.agency.shortCode} — {detail.agency.name} · {formatDisplayDateRange(detail.startDate, detail.endDate)} (
                {nights} night{nights === 1 ? "" : "s"} / {nights + 1} days) · Owner:{" "}
                {detail.owner.name || detail.owner.email} · Validator:{" "}
                {detail.validator ? detail.validator.name || detail.validator.email : "not assigned"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* Version switch reads as a segmented control, not a row of
                  primary buttons — the green accent stays off chrome. */}
              <div className="flex items-center gap-0.5 rounded-lg bg-muted p-1">
                {detail.versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedVersionId(v.id)}
                    className={
                      v.id === version.id
                        ? "rounded-md bg-card px-3 py-1 text-[13px] font-medium text-foreground shadow-sm"
                        : "rounded-md px-3 py-1 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                    }
                  >
                    {versionLabel(v.versionNo)}
                  </button>
                ))}
              </div>
              {canRevise && (
                <Button size="sm" variant="outline" onClick={() => setReviseOpen(true)} disabled={busy}>
                  New revision
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setCompareOpen((o) => !o)}>
                Compare
              </Button>
            </div>
          </div>
        </CardHeader>
        {compareOpen && (
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={compareA} onValueChange={setCompareA}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Version A" />
                </SelectTrigger>
                <SelectContent>
                  {detail.versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {versionLabel(v.versionNo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={compareB} onValueChange={setCompareB}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Version B" />
                </SelectTrigger>
                <SelectContent>
                  {detail.versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {versionLabel(v.versionNo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {cmpA && cmpB && <VersionCompare a={cmpA} b={cmpB} fallbackCurrency={quoteCurrency} />}
          </CardContent>
        )}
      </Card>

      <QuoteSummaryBar ctx={ctx} />

      <Tabs defaultValue="overview" className="space-y-4">
        {/* Page-level tabs use the underline style; the segmented default is
            reserved for in-card tab sets (catalog admin). */}
        <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-none border-b bg-transparent p-0">
          {(["overview", "itinerary", "scenarios", "review", "history"] as const).map((tab) => (
            <TabsTrigger key={tab} value={tab} className={PAGE_TAB_CLASS}>
              {tab[0].toUpperCase() + tab.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab ctx={ctx} />
        </TabsContent>
        <TabsContent value="itinerary">
          <ItineraryTab ctx={ctx} />
        </TabsContent>
        <TabsContent value="scenarios">
          <ScenariosTab ctx={ctx} />
        </TabsContent>
        <TabsContent value="review">
          <ReviewTab ctx={ctx} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab ctx={ctx} />
        </TabsContent>
      </Tabs>

      <Dialog open={reviseOpen} onOpenChange={setReviseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new revision?</DialogTitle>
            <DialogDescription>
              A new draft revision ({versionLabel(latest.versionNo + 1)}) is cloned from the latest version —
              scenarios, itinerary and service lines come along.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviseOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleNewRevision} disabled={busy}>
              {busy ? "Creating..." : "Create revision"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function scenarioResult(v: VersionDetail, scenarioId: string): ScenarioResult | null {
  const sc = v.scenarios.find((s) => s.id === scenarioId);
  return parseJson<ScenarioResult | null>(sc?.resultJson, null);
}

function VersionCompare({ a, b, fallbackCurrency }: { a: VersionDetail; b: VersionDetail; fallbackCurrency: string }) {
  const labels = Array.from(new Set([...a.scenarios.map((s) => s.label), ...b.scenarios.map((s) => s.label)]));
  return (
    <div className="mt-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scenario</TableHead>
            <TableHead>
              {versionLabel(a.versionNo)} ({a.status})
            </TableHead>
            <TableHead>
              {versionLabel(b.versionNo)} ({b.status})
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {labels.map((label) => {
            const scA = a.scenarios.find((s) => s.label === label);
            const scB = b.scenarios.find((s) => s.label === label);
            const resA = scA ? scenarioResult(a, scA.id) : null;
            const resB = scB ? scenarioResult(b, scB.id) : null;
            const cell = (sc: typeof scA, res: ScenarioResult | null, currency: string) => {
              if (!sc) return "—";
              if (!res) return sc.valid ? "valid (no result)" : "not calculated";
              return `${res.valid ? "valid" : "invalid"} · ${res.issues.length} issue(s) · sell ${money(res.sell, currency)}`;
            };
            return (
              <TableRow key={label}>
                <TableCell>{label}</TableCell>
                <TableCell>{cell(scA, resA, a.quoteCurrency ?? fallbackCurrency)}</TableCell>
                <TableCell>{cell(scB, resB, b.quoteCurrency ?? fallbackCurrency)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
