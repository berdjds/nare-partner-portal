/**
 * Permission-gated redaction of internal costing from engine results.
 *
 * Internal costing (costQuote, profit, margin, category totals, nightly rates,
 * per-line net costs, trace, policy targets) and INTERNAL documents leave the
 * travel APIs only for actors holding the `travel.internal.view` permission
 * (int-lock). Under decision D2 — until the owner confirms the permissions
 * migration — only ADMIN has the key in its role preset, so owners and
 * validators see the redacted sell-side view unless explicitly granted the
 * key via a UserPermission override. Non-owner advisors are 404'd by the
 * routes before redaction is even reachable, so these helpers remain as
 * defense in depth.
 */

import type { PermissionKey } from "@/lib/permissions";
import { hasPermission } from "@/lib/permissions";
import type { ScenarioResult } from "@/lib/travel/contracts";

/**
 * Single gate for internal-cost visibility across the travel APIs (int-lock).
 * Anything carrying an effective permission set qualifies; an absent set
 * (e.g. an unresolved actor) never satisfies the key — redact by default.
 */
export function canViewInternal(
  actor: { permissions?: ReadonlySet<PermissionKey> | undefined } | null | undefined,
): boolean {
  return hasPermission(actor, "travel.internal.view");
}

/** The exact sell-side fields an actor without `travel.internal.view` may see per scenario. */
export interface AdvisorScenarioView {
  ref: string;
  label: string;
  valid: boolean;
  issues: unknown[];
  nights: number;
  days: number;
  sell: unknown;
  perPayingPerson: unknown;
}

export function redactScenarioResult(sc: Partial<ScenarioResult>): AdvisorScenarioView {
  return {
    ref: sc.ref ?? "",
    label: sc.label ?? "",
    valid: sc.valid ?? false,
    issues: sc.issues ?? [],
    nights: sc.nights ?? 0,
    days: sc.days ?? 0,
    sell: sc.sell ?? null,
    perPayingPerson: sc.perPayingPerson ?? null,
  };
}

/**
 * Redacts a stored ScenarioResult JSON string (Scenario.resultJson). A blob
 * that cannot be parsed redacts to the empty-but-safe shape rather than
 * leaking anything.
 */
export function redactScenarioResultJson(resultJson: string | null): string | null {
  if (resultJson == null) return null;
  try {
    return JSON.stringify(redactScenarioResult(JSON.parse(resultJson)));
  } catch {
    return JSON.stringify(redactScenarioResult({}));
  }
}

// ---------------------------------------------------------------------------
// ServiceLine / StaySegment redaction (int-lock). The scenario RESULT blob is
// redacted above; these two helpers cover the stored content rows that the
// request-detail route also returns, which carry the same internal costing:
// net unit/override rates, override reasons, rate provenance, and the
// per-roomType rate-override JSON (rate + reason + actor).
// ---------------------------------------------------------------------------

const INTERNAL_SERVICE_LINE_KEYS = [
  "unitRate", // net cost per unit
  "overrideRate", // overridden net cost
  "overrideReason", // internal note
  "overrideById", // who overrode (attribution)
  "sourceRef", // rate provenance, e.g. "Tour Calculator!C58"
] as const;

/**
 * Strips the internal costing fields from a ServiceLine row, keeping the
 * sell-side display fields (label, basis, quantity, currency, ...).
 */
export function redactServiceLine<T extends object>(
  line: T,
): Omit<T, (typeof INTERNAL_SERVICE_LINE_KEYS)[number]> {
  const clone = { ...(line as Record<string, unknown>) };
  for (const key of INTERNAL_SERVICE_LINE_KEYS) delete clone[key];
  return clone as Omit<T, (typeof INTERNAL_SERVICE_LINE_KEYS)[number]>;
}

/**
 * Nulls StaySegment.rateOverrides — a JSON map of per-roomType overridden net
 * rates with reason and actor. Nulled rather than removed because the client
 * detail types declare `rateOverrides: string | null`.
 */
export function redactStay<T extends object>(stay: T): Omit<T, "rateOverrides"> & { rateOverrides: null } {
  return { ...(stay as Record<string, unknown>), rateOverrides: null } as Omit<T, "rateOverrides"> & {
    rateOverrides: null;
  };
}

// ---------------------------------------------------------------------------
// QuoteDocument client view — the filesystem path and internal render errors
// are never exposed; a FAILED render surfaces as a state + generic message.
// ---------------------------------------------------------------------------

export const DOCUMENT_RENDER_FAILED_MESSAGE = "Document rendering failed — retry the document";

export interface DocumentView {
  id: string;
  kind: string;
  issuedAt: Date | null;
  createdAt: Date;
  renderState: "PENDING" | "FAILED" | "READY";
  renderMessage: string | null;
}

export function publicDocumentView(d: {
  id: string;
  kind: string;
  filePath: string;
  issuedAt: Date | null;
  createdAt: Date;
}): DocumentView {
  const renderState =
    d.filePath === "PENDING" ? "PENDING" : d.filePath.startsWith("FAILED:") ? "FAILED" : "READY";
  return {
    id: d.id,
    kind: d.kind,
    issuedAt: d.issuedAt,
    createdAt: d.createdAt,
    renderState,
    renderMessage: renderState === "FAILED" ? DOCUMENT_RENDER_FAILED_MESSAGE : null,
  };
}
