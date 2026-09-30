import { NextRequest, NextResponse } from "next/server";
import { canViewInternal, redactScenarioResult } from "@/lib/travel/redact";
import { submit } from "@/lib/travel/workflow";
import { getTravelActor, travelError, unauthorized } from "../../../guard";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getTravelActor();
  if (!actor) return unauthorized();

  try {
    const submitted = await submit(actor, id);
    // submit() asserts owner-or-admin, but the response carries the full engine
    // result — int-lock redacts costing to sell-side fields for any actor
    // without travel.internal.view (D2: owners included, until granted).
    if (!canViewInternal(actor)) {
      return NextResponse.json({
        ...submitted,
        result: { ...submitted.result, scenarios: submitted.result.scenarios.map(redactScenarioResult) },
      });
    }
    return NextResponse.json(submitted);
  } catch (err) {
    return travelError(err, "[API /travel/requests/[id]/submit]");
  }
}
