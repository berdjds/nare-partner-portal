import { NextRequest, NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ROLE_ADMIN, ROLE_ADVISOR, ROLE_VALIDATOR } from "@/lib/travel/contracts";
import type { EngineInput, ScenarioResult } from "@/lib/travel/contracts";
import { publicDocumentView, redactScenarioResultJson } from "@/lib/travel/redact";
import { buildTraceRows, type TraceRow } from "@/lib/travel/trace-table";
import { updateDraft, updateDraftSchema } from "@/lib/travel/workflow";
import { writeAuditLog } from "@/lib/audit";
import { getTravelActor, travelError, unauthorized } from "../../guard";

const patchBodySchema = z.object({
  expectedRevision: z.number().int().min(0),
  patch: updateDraftSchema,
});

// Full detail: agency, versions with scenarios/stays/lines, snapshot summary
// (hash + validity, not the full result blob), assignments, decisions, and
// document metadata without filesystem paths. Advisors get 404 for other
// advisors' requests (IDOR). The request owner sees full costing (v0.11.0) —
// redaction to sell-side fields would only apply to a non-owner advisor.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const request = await prisma.travelRequest.findUnique({
      where: { id: id },
      include: {
        agency: true,
        owner: { select: { id: true, email: true, name: true, role: true } },
        validator: { select: { id: true, email: true, name: true, role: true } },
        versions: {
          orderBy: { versionNo: "asc" },
          include: {
            scenarios: { include: { stays: true } },
            itineraryDays: { orderBy: { dayOffset: "asc" } },
            serviceLines: true,
            snapshot: {
              // inputsJson is consumed server-side to rebuild the frozen trace
              // rows (v0.15.0); snapshotPublic below never returns it.
              select: { id: true, hash: true, engineVersion: true, createdAt: true, displayJson: true, inputsJson: true },
            },
            decisions: { orderBy: { createdAt: "desc" } },
            documents: {
              select: {
                id: true,
                kind: true,
                filePath: true, // consumed by publicDocumentView, never returned
                issuedAt: true,
                createdAt: true,
              },
            },
          },
        },
        assignments: {
          orderBy: { createdAt: "desc" },
          include: { validator: { select: { id: true, email: true, name: true } } },
        },
      },
    });
    if (!request) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Existence of other advisors' requests is not disclosed.
    if (actor.role === ROLE_ADVISOR && request.ownerId !== actor.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Users without a travel role (assigned validators, v0.10.0) may only
    // open requests they own or actively validate.
    if (![ROLE_ADMIN, ROLE_VALIDATOR, ROLE_ADVISOR].includes(actor.role as any)) {
      const assigned = request.assignments.some((a) => a.active && a.validatorId === actor.id);
      if (request.ownerId !== actor.id && !assigned) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    }
    const advisorView = actor.role === ROLE_ADVISOR;
    // v0.11.0: the request owner sees full costing (per-line net costs — the
    // initiator prices the request). Redaction remains for a hypothetical
    // non-owner advisor; they are 404'd above, so this is defense in depth.
    const redactResults = advisorView && request.ownerId !== actor.id;

    // Fallback paying-pax for trace rows when a frozen scenario input lacks
    // its own traveler counts (mirrors the PDF renderer's request-level fallback).
    let requestPayingPax = 1;
    try {
      const t = JSON.parse(request.travelers);
      if (typeof t.paying === "number" && t.paying > 0) requestPayingPax = t.paying;
    } catch {
      requestPayingPax = 1;
    }

    const sanitized = {
      ...request,
      versions: request.versions.map((v) => {
        // The snapshot's frozen display data carries the quote currency the
        // price was computed in (absent on pre-freeze snapshots).
        let quoteCurrency: string | null = null;
        if (v.snapshot?.displayJson) {
          try {
            const parsed = JSON.parse(v.snapshot.displayJson);
            quoteCurrency = typeof parsed.quoteCurrency === "string" ? parsed.quoteCurrency : null;
          } catch {
            quoteCurrency = null;
          }
        }
        // Frozen engine input for rebuilding the v0.15.0 trace rows. Never
        // returned — only snapshotPublic leaves this route.
        let snapshotInputs: EngineInput | null = null;
        if (!redactResults && v.snapshot?.inputsJson) {
          try {
            snapshotInputs = JSON.parse(v.snapshot.inputsJson) as EngineInput;
          } catch {
            snapshotInputs = null;
          }
        }
        const snapshotPublic = v.snapshot
          ? {
              id: v.snapshot.id,
              hash: v.snapshot.hash,
              engineVersion: v.snapshot.engineVersion,
              createdAt: v.snapshot.createdAt,
            }
          : null;
        return {
          ...v,
          quoteCurrency,
          snapshot: snapshotPublic,
          scenarios: v.scenarios.map((sc) => {
            // traceRows (v0.15.0): the frozen calculation breakdown, rebuilt
            // from the snapshot's inputs + this scenario's frozen result —
            // the same rows the internal costing PDF renders. Full costing,
            // so they follow the resultJson redaction rule exactly.
            let traceRows: TraceRow[] | undefined;
            if (snapshotInputs && sc.resultJson) {
              try {
                const result = JSON.parse(sc.resultJson) as ScenarioResult;
                traceRows = buildTraceRows({
                  quoteCurrency: snapshotInputs.fx.quoteCurrency,
                  fxRates: snapshotInputs.fx.rates,
                  policy: snapshotInputs.policy,
                  result,
                  scenario: snapshotInputs.scenarios.find((s) => s.ref === sc.id),
                  fallbackPayingPax: requestPayingPax,
                });
              } catch {
                traceRows = undefined;
              }
            }
            return {
              ...sc,
              resultJson: redactResults ? redactScenarioResultJson(sc.resultJson) : sc.resultJson,
              traceRows,
            };
          }),
          documents: v.documents
            // INTERNAL documents carry margins — advisors never see them,
            // not even as list metadata.
            .filter((d) => !advisorView || d.kind !== "INTERNAL")
            .map(publicDocumentView),
        };
      }),
    };
    return NextResponse.json(sanitized);
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]]");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => null);
  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const updated = await updateDraft(actor, id, parsed.data.expectedRevision, parsed.data.patch);
    return NextResponse.json(updated);
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]]");
  }
}

// Hard delete of a request and everything hanging off it (v0.12.0 — added so
// test/junk requests can be cleaned up). ADMIN only. Children are deleted
// explicitly in dependency order inside one transaction rather than relying on
// the schema's onDelete: Cascade, so behavior is identical on databases whose
// FKs predate the cascade annotations. Rendered PDF files under
// data/documents/ are unlinked best-effort afterwards — a missing file must
// not fail the delete (it may already be gone).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();
  if (actor.role !== ROLE_ADMIN) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const request = await prisma.travelRequest.findUnique({
      where: { id: id },
      include: { versions: { select: { id: true, documents: { select: { filePath: true } } } } },
    });
    if (!request) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await writeAuditLog(
      "TRAVEL_REQUEST_DELETED",
      actor.id,
      `Deleted request ${request.packageCode} "${request.title}" (${request.versions.length} version(s))`,
    );

    const versionIds = request.versions.map((v) => v.id);
    const filePaths = request.versions.flatMap((v) => v.documents.map((d) => d.filePath));
    await prisma.$transaction([
      prisma.notificationDelivery.deleteMany({ where: { event: { requestId: request.id } } }),
      prisma.workflowEvent.deleteMany({ where: { requestId: request.id } }),
      prisma.validationAssignment.deleteMany({ where: { requestId: request.id } }),
      prisma.staySegment.deleteMany({ where: { scenario: { versionId: { in: versionIds } } } }),
      prisma.scenario.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.itineraryDay.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.serviceLine.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.calculationSnapshot.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.reviewDecision.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.quoteDocument.deleteMany({ where: { versionId: { in: versionIds } } }),
      prisma.quoteVersion.deleteMany({ where: { requestId: request.id } }),
      prisma.travelRequest.delete({ where: { id: request.id } }),
    ]);

    for (const filePath of filePaths) {
      await unlink(filePath).catch(() => null);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id] DELETE]");
  }
}
