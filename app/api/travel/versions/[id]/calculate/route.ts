import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { POLICY_TYPES, ROLE_ADMIN, ROLE_ADVISOR, ROLE_VALIDATOR } from "@/lib/travel/contracts";
import { calculate } from "@/lib/travel/engine";
import { canViewInternal, redactScenarioResult } from "@/lib/travel/redact";
import { buildEngineInputForVersion } from "@/lib/travel/resolve";
import { buildTraceRows } from "@/lib/travel/trace-table";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

const moneyField = z.string().trim().regex(/^\d+(\.\d+)?$/, "expected a non-negative decimal string");

const previewSchema = z.object({
  // What-if policy override; never persisted, never part of a snapshot.
  // ADMIN/VALIDATOR only — an advisor must not probe arbitrary margins.
  policy: z
    .object({
      type: z.enum(POLICY_TYPES),
      rate: moneyField.optional(),
      minProfit: moneyField.optional(),
      minProfitCurrency: z.string().max(10).optional(),
      feeFraction: moneyField.optional(),
      roundingIncrement: moneyField.default("1"),
    })
    .optional(),
  quoteCurrency: z.string().max(10).optional(),
});

// Preview calculation: resolves and runs the engine WITHOUT persisting a
// snapshot (only submit() binds a snapshot to the version). Access is limited
// to the request owner, the currently assigned validator and ADMIN — anything
// else gets 404 so version ids do not disclose request ownership.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const parsed = previewSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors }, { status: 400 });
  }

  try {
    const version = await prisma.quoteVersion.findUnique({
      where: { id },
      include: { request: { select: { id: true, ownerId: true } } },
    });
    if (!version) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const isAdmin = actor.role === ROLE_ADMIN;
    const isOwner = version.request.ownerId === actor.id;
    let isAssignedValidator = false;
    if (actor.role === ROLE_VALIDATOR) {
      const assignment = await prisma.validationAssignment.findFirst({
        where: { requestId: version.requestId, active: true },
        select: { validatorId: true },
      });
      isAssignedValidator = assignment?.validatorId === actor.id;
    }
    if (!isAdmin && !isOwner && !isAssignedValidator) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (actor.role === ROLE_ADVISOR && (parsed.data.policy || parsed.data.quoteCurrency)) {
      return NextResponse.json(
        { error: "policy overrides are restricted to ADMIN/VALIDATOR", code: "FORBIDDEN" },
        { status: 403 },
      );
    }

    const input = await buildEngineInputForVersion(id, {
      policyOverride: parsed.data.policy,
      quoteCurrencyOverride: parsed.data.quoteCurrency,
    });
    const result = calculate(input);
    const quoteCurrency = input.fx.quoteCurrency;

    if (!canViewInternal(actor)) {
      // int-lock: sell-side fields only — internal costing never leaves this
      // route without the travel.internal.view permission (D2: admin-only
      // preset; owners/validators need an explicit grant). traceRows carry the
      // full costing breakdown, so they are never attached here either.
      return NextResponse.json({
        valid: result.valid,
        engineVersion: result.engineVersion,
        quoteCurrency,
        scenarios: result.scenarios.map(redactScenarioResult),
      });
    }
    // traceRows (v0.15.0): response-only calculation breakdown per scenario —
    // the same rows the internal costing PDF renders. NOT part of the frozen
    // ScenarioResult contract; never persisted into snapshots.
    const fallbackPayingPax = input.scenarios[0]?.travelers.paying ?? 1;
    const scenarios = result.scenarios.map((res) => ({
      ...res,
      traceRows: buildTraceRows({
        quoteCurrency,
        fxRates: input.fx.rates,
        policy: input.policy,
        result: res,
        scenario: input.scenarios.find((s) => s.ref === res.ref),
        fallbackPayingPax,
      }),
    }));
    return NextResponse.json({ ...result, scenarios, quoteCurrency });
  } catch (err) {
    return travelError(err, "[API /travel/versions/[id]/calculate]");
  }
}
