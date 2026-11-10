/**
 * Advisor price guidance (owner decision of B2B cycle 1: advisors never see supplier
 * rates, costs, margins, markups or internal calculations; they may see a sell-side
 * figure computed on the server).
 *
 * The figure is the engine's sell side only, taken through the same allow-list
 * redaction as the rest of the travel API (redactScenarioResult). Issues are reduced
 * to code + severity: their free-text messages can quote floors, margins or rates.
 * The same shape is returned to every actor; internal detail stays on the calculate
 * route behind canViewInternalFor.
 */

import { calculate } from "@/lib/travel/engine";
import { buildEngineInputForVersion } from "@/lib/travel/resolve";
import { redactScenarioResult } from "@/lib/travel/redact";

export interface Guidance {
  available: boolean;
  /** Present when not available: a stable code, never engine text. */
  reason?: string;
  quoteCurrency?: string;
  valid?: boolean;
  scenarios?: Array<{
    ref: string;
    label: string;
    valid: boolean;
    nights: number;
    days: number;
    sell: unknown;
    perPayingPerson: unknown;
    issues: Array<{ code: string; severity: string }>;
  }>;
}

export async function sellSideGuidance(versionId: string): Promise<Guidance> {
  try {
    const input = await buildEngineInputForVersion(versionId);
    const result = calculate(input);
    return {
      available: true,
      quoteCurrency: input.fx.quoteCurrency,
      valid: result.valid,
      scenarios: result.scenarios.map((sc) => {
        const r = redactScenarioResult(sc);
        return {
          ref: r.ref, label: r.label, valid: r.valid, nights: r.nights, days: r.days,
          sell: r.sell, perPayingPerson: r.perPayingPerson,
          issues: (r.issues as Array<{ code?: string; severity?: string }>).map((i) => ({ code: String(i.code ?? "UNKNOWN"), severity: String(i.severity ?? "WARNING") })),
        };
      }),
    };
  } catch {
    return { available: false, reason: "NOT_CALCULABLE" };
  }
}
