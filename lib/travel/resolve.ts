/**
 * DB → engine DTO resolution.
 *
 * Builds the pure EngineInput (contracts.ts) for a QuoteVersion by loading the
 * request, scenarios, stay segments, service lines, catalog rates, FX and the
 * active pricing policy. The engine itself is pure; ALL database access for a
 * calculation lives here, so the same version always resolves to the same
 * snapshot input.
 *
 * Unresolvable state throws ResolutionError with a machine-readable `code`
 * (and, for per-stay problems, an aggregated `details` list). Rate-level
 * blockers that are data problems rather than workflow errors (missing rate,
 * missing FX, missing policy) are intentionally NOT thrown here — they are
 * represented in the EngineInput so the engine reports them as issues.
 *
 * Known gaps (documented, deliberate):
 * - vehicleChecks are not resolved: there is no version-level vehicle
 *   assignment column, so transport capacity checks are skipped until the
 *   schema grows one.
 * - RateVersion.weekdays and minStay are ignored when mapping rates; stopSales
 *   and quoteOnRequest ARE enforced (they are hard blockers, not hints).
 */

import { prisma } from "@/lib/prisma";
import {
  ENGINE_VERSION,
  type EngineInput,
  type ISODate,
  type PolicyInput,
  type PolicyType,
  type RatePeriod,
  type RoomAllocationInput,
  type ServiceLineInput,
  type StaySegmentInput,
  type TravelerSetup,
} from "@/lib/travel/contracts";
import { getActivePolicy, getFxMap } from "@/lib/travel/settings";
import type {
  HotelProduct,
  QuoteVersion,
  RateVersion,
  Scenario,
  ServiceLine,
  StaySegment,
  TravelRequest,
} from "@prisma/client";

export type ResolutionErrorCode =
  | "VERSION_NOT_FOUND"
  | "TRAVELERS_INVALID"
  | "ALLOCATIONS_INVALID"
  | "OVERRIDE_INVALID"
  | "STOP_SALE"
  | "QUOTE_ON_REQUEST"
  | "AMBIGUOUS_RATE";

export interface ResolutionIssue {
  code: ResolutionErrorCode;
  message: string;
  stayId?: string;
  roomType?: string;
}

export class ResolutionError extends Error {
  constructor(
    public readonly code: ResolutionErrorCode,
    message: string,
    public readonly details?: ResolutionIssue[],
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

/** Stored on StaySegment.rateOverrides: per-roomType override record. */
interface RateOverrideRecord {
  rate: string;
  reason: string;
  actorId: string;
}

interface StopSaleWindow {
  from: string;
  to: string;
  reason?: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isValidISODateLocal(d: unknown): d is string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function parseTravelers(raw: string): TravelerSetup {
  const t = parseJson<Partial<TravelerSetup> | null>(raw, null);
  const ints = ["adults", "children", "infants", "paying", "complimentary", "leaders", "staff"] as const;
  if (!t || ints.some((k) => typeof t[k] !== "number" || !Number.isInteger(t[k]) || (t[k] as number) < 0)) {
    throw new ResolutionError(
      "TRAVELERS_INVALID",
      "request.travelers is not a valid TravelerSetup JSON object",
    );
  }
  return t as TravelerSetup;
}

/** [aFrom, aTo) intersects [bFrom, bTo) — ISO strings compare lexicographically. */
function rangesIntersect(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** Occupancy codes that map directly onto allocation roomType keys. */
const ROOM_OCCUPANCIES = new Set(["SGL", "DBL", "TPL", "UNIT"]);

/**
 * Fills capacity fields from the linked HotelProduct when the allocation JSON
 * does not carry its own snapshot. Allocation JSON wins (it is the frozen
 * record of what the advisor saw); the product is only a fallback.
 */
function normalizeAllocations(
  stay: StaySegment,
  product: HotelProduct | null,
): RoomAllocationInput[] {
  const raw = parseJson<Partial<RoomAllocationInput>[]>(stay.allocations, []);
  if (!Array.isArray(raw)) {
    throw new ResolutionError("ALLOCATIONS_INVALID", `stay ${stay.id}: allocations JSON is not an array`);
  }
  return raw.map((a, i) => {
    if (!a || typeof a.roomType !== "string" || typeof a.rooms !== "number") {
      throw new ResolutionError(
        "ALLOCATIONS_INVALID",
        `stay ${stay.id}: allocation #${i} lacks roomType/rooms`,
      );
    }
    return {
      roomType: a.roomType,
      rooms: a.rooms,
      adults: a.adults ?? 0,
      children: a.children ?? 0,
      infants: a.infants ?? 0,
      extraBeds: a.extraBeds ?? 0,
      capacityAdults: a.capacityAdults ?? product?.capacityAdults ?? 2,
      capacityChildren: a.capacityChildren ?? product?.capacityChildren ?? 0,
      capacityTotal: a.capacityTotal ?? product?.capacityTotal ?? 2,
      extraBedAllowed: a.extraBedAllowed ?? product?.extraBedAllowed ?? false,
      extraBedIncludedInRate: a.extraBedIncludedInRate ?? false,
      wholeUnit: a.wholeUnit ?? product?.kind === "COTTAGE_UNIT",
    };
  });
}

function resolveStayRates(
  stay: StaySegment,
  rateRows: RateVersion[],
  quoteCurrency: string,
  issues: ResolutionIssue[],
): Record<string, RatePeriod[]> {
  const allocations = parseJson<Partial<RoomAllocationInput>[]>(stay.allocations, []);
  const selectedRoomTypes = new Set(
    (Array.isArray(allocations) ? allocations : [])
      .filter((a) => (a?.rooms ?? 0) > 0)
      .map((a) => a.roomType as string),
  );
  const extraBedsRequested = (Array.isArray(allocations) ? allocations : []).some(
    (a) => (a?.rooms ?? 0) > 0 && (a?.extraBeds ?? 0) > 0,
  );

  const overrides = parseJson<Record<string, RateOverrideRecord>>(stay.rateOverrides, {});
  for (const [roomType, ov] of Object.entries(overrides)) {
    // An override without evidence is worse than no override: it would let a
    // fabricated rate through silently, so it is a hard resolution error.
    if (!ov || typeof ov.rate !== "string" || !ov.reason?.trim() || !ov.actorId?.trim()) {
      issues.push({
        code: "OVERRIDE_INVALID",
        message: `stay ${stay.id} ${roomType}: rate override requires rate, reason and actorId`,
        stayId: stay.id,
        roomType,
      });
    }
  }

  const rates: Record<string, RatePeriod[]> = {};
  // EXTRA_BED rows attach as the extra-bed supplement on same-board periods.
  const extraBedRows: RateVersion[] = [];

  for (const row of rateRows) {
    const occupancy = row.occupancy ?? "";
    if (occupancy === "EXTRA_BED") {
      extraBedRows.push(row);
      continue;
    }
    if (!ROOM_OCCUPANCIES.has(occupancy)) continue; // unmappable occupancy — ignored
    // When the stay names a board, rates contracted for other boards would
    // collide at equal priority (AMBIGUOUS_RATE); filter them out up front.
    if (stay.board && row.board && row.board !== stay.board) continue;

    // Hard blockers on SELECTED room types: a stop-sale window intersecting
    // the stay, or a quote-on-request rate, cannot be priced automatically.
    // An evidence-backed override (reason + actor) is the documented exception.
    const hasOverride = !!overrides[occupancy]?.reason?.trim() && !!overrides[occupancy]?.actorId?.trim();
    if (selectedRoomTypes.has(occupancy) && !hasOverride) {
      if (row.quoteOnRequest) {
        issues.push({
          code: "QUOTE_ON_REQUEST",
          message: `stay ${stay.id} ${occupancy}: rate ${row.id} is quote-on-request and needs an evidenced override`,
          stayId: stay.id,
          roomType: occupancy,
        });
      }
      const windows = parseJson<StopSaleWindow[]>(row.stopSales, []);
      for (const w of Array.isArray(windows) ? windows : []) {
        if (isValidISODateLocal(w.from) && isValidISODateLocal(w.to) &&
            rangesIntersect(w.from, w.to, stay.checkIn, stay.checkOut)) {
          issues.push({
            code: "STOP_SALE",
            message: `stay ${stay.id} ${occupancy}: rate ${row.id} has a stop-sale ${w.from}→${w.to}${w.reason ? ` (${w.reason})` : ""} intersecting the stay`,
            stayId: stay.id,
            roomType: occupancy,
          });
        }
      }
    }

    const period: RatePeriod = {
      // Open-ended catalog rows cover the whole segment.
      from: row.validFrom ?? stay.checkIn,
      to: row.validTo ?? stay.checkOut,
      rate: row.amount, // null = TBC; the engine blocks TBC on selected types
      currency: row.currency,
      priority: row.priority,
      sourceRef: `RateVersion ${row.id} (${row.evidenceRef ?? "no evidence"})`,
    };
    const list = rates[occupancy] ?? [];
    list.push(period);
    rates[occupancy] = list;
  }

  for (const row of extraBedRows) {
    if (stay.board && row.board && row.board !== stay.board) continue;
    // EXTRA_BED rows get the same hard blockers as room rates: a stop-sold or
    // quote-on-request supplement cannot be priced automatically when the
    // allocation actually requests extra beds.
    if (extraBedsRequested) {
      if (row.quoteOnRequest) {
        issues.push({
          code: "QUOTE_ON_REQUEST",
          message: `stay ${stay.id} EXTRA_BED: rate ${row.id} is quote-on-request and cannot supplement automatically`,
          stayId: stay.id,
          roomType: "EXTRA_BED",
        });
      }
      const windows = parseJson<StopSaleWindow[]>(row.stopSales, []);
      for (const w of Array.isArray(windows) ? windows : []) {
        if (isValidISODateLocal(w.from) && isValidISODateLocal(w.to) &&
            rangesIntersect(w.from, w.to, stay.checkIn, stay.checkOut)) {
          issues.push({
            code: "STOP_SALE",
            message: `stay ${stay.id} EXTRA_BED: rate ${row.id} has a stop-sale ${w.from}→${w.to}${w.reason ? ` (${w.reason})` : ""} intersecting the stay`,
            stayId: stay.id,
            roomType: "EXTRA_BED",
          });
        }
      }
    }
    // Attach the supplement only to periods the extra-bed row's own validity
    // fully covers — an open-ended row covers everything, a seasonal row only
    // its season.
    const ebFrom = row.validFrom ?? null;
    const ebTo = row.validTo ?? null;
    for (const periods of Object.values(rates)) {
      for (const p of periods) {
        const covers = (ebFrom === null || ebFrom <= p.from) && (ebTo === null || p.to <= ebTo);
        if (covers && p.currency === row.currency && p.extraBedRate === undefined) {
          p.extraBedRate = row.amount; // null = TBC supplement; engine blocks
        }
      }
    }
  }

  // Overrides win over the catalog: they are appended at a priority above any
  // catalog row for the same room type.
  for (const [roomType, ov] of Object.entries(overrides)) {
    if (!ov?.reason?.trim() || !ov?.actorId?.trim()) continue; // already reported
    const existing = rates[roomType] ?? [];
    const top = existing.reduce((m, p) => Math.max(m, p.priority), 0);
    const currency = existing[0]?.currency ?? quoteCurrency;
    // The override changes the room price, not the supplement semantics: the
    // extra-bed rate of the winning catalog period carries over so a priced
    // override does not silently drop the agreed supplement.
    const winner = existing.length
      ? existing.reduce((best, p) => (p.priority > best.priority ? p : best), existing[0])
      : null;
    const period: RatePeriod = {
      from: stay.checkIn,
      to: stay.checkOut,
      rate: ov.rate,
      currency,
      priority: top + 1000,
      ...(winner?.extraBedRate !== undefined ? { extraBedRate: winner.extraBedRate } : {}),
      sourceRef: `manual override by ${ov.actorId}: ${ov.reason}`,
    };
    rates[roomType] = [...existing, period];
  }

  return rates;
}

/**
 * Picks the catalog rate band for a service line on `referenceDate`, mirroring
 * the stay-rate rules: validity is [validFrom, validTo) with open ends covering
 * everything, the highest priority wins, an equal-priority tie is AMBIGUOUS_RATE
 * and quote-on-request is a hard blocker. A TBC winner (amount null) returns
 * null so the engine's MISSING_RATE blocker fires — TBC must never be coerced
 * to 0. Returns null also when no band covers the date.
 *
 * Vehicle scoping (per-vehicle transportation pricing): when the line names a
 * vehicleTypeId, only rows for THAT vehicle are considered; if none of them
 * cover the date, the vehicle-agnostic rows (vehicleTypeId null) are the
 * fallback. Lines without a vehicle selection use the full row set as before
 * (vehicle rows outrank the base row by priority).
 */
function resolveServiceRate(
  line: ServiceLine,
  rateRows: RateVersion[],
  referenceDate: string,
  issues: ResolutionIssue[],
): { unitRate: string; currency: string; sourceRef: string } | null {
  // ISO calendar strings compare lexicographically — safe for [from, to).
  const covers = (row: RateVersion) =>
    (row.validFrom ?? "") <= referenceDate && referenceDate < (row.validTo ?? "￿");
  let pool = rateRows;
  if (line.vehicleTypeId) {
    const vehicleRows = rateRows.filter((row) => row.vehicleTypeId === line.vehicleTypeId);
    pool = vehicleRows.some(covers)
      ? vehicleRows
      : rateRows.filter((row) => row.vehicleTypeId === null);
  }
  const covering = pool.filter(covers);
  if (covering.length === 0) return null;
  const top = Math.max(...covering.map((row) => row.priority));
  const winners = covering.filter((row) => row.priority === top);
  if (winners.length > 1) {
    issues.push({
      code: "AMBIGUOUS_RATE",
      message: `service line ${line.id} "${line.label}": ${winners.length} service rates with equal priority ${top} cover ${referenceDate}`,
    });
    return null;
  }
  const winner = winners[0];
  if (winner.quoteOnRequest) {
    issues.push({
      code: "QUOTE_ON_REQUEST",
      message: `service line ${line.id} "${line.label}": rate ${winner.id} is quote-on-request and cannot price automatically`,
    });
    return null;
  }
  if (winner.amount === null) return null; // TBC — engine's MISSING_RATE fires
  return {
    unitRate: winner.amount,
    currency: winner.currency,
    sourceRef: `RateVersion ${winner.id} (${winner.evidenceRef ?? "no evidence"})`,
  };
}

function resolveServiceLine(
  line: ServiceLine,
  serviceRateRows: RateVersion[],
  referenceDate: string,
  issues: ResolutionIssue[],
  vehicleTypeName?: string,
): ServiceLineInput {
  let unitRate = line.unitRate;
  let currency = line.currency;
  let sourceRef = line.sourceRef ?? undefined;
  const hasOverride = line.overrideRate != null;
  // A catalog-linked line without a hand-typed rate resolves from the rate
  // band valid on its day (or the tour start when not day-linked). A manual
  // override always wins, so catalog resolution is skipped when one is set.
  if (line.serviceProductId && unitRate === null && !hasOverride) {
    const resolved = resolveServiceRate(line, serviceRateRows, referenceDate, issues);
    if (resolved) {
      unitRate = resolved.unitRate;
      currency = resolved.currency;
      sourceRef = sourceRef ?? resolved.sourceRef;
    }
  }
  let override: ServiceLineInput["override"];
  if (line.overrideRate != null) {
    // Same rule as stay overrides: an override without evidence is an error.
    if (!line.overrideReason?.trim() || !line.overrideById?.trim()) {
      issues.push({
        code: "OVERRIDE_INVALID",
        message: `service line ${line.id} "${line.label}": overrideRate requires overrideReason and overrideById`,
      });
    } else {
      unitRate = line.overrideRate;
      override = {
        originalRate: line.unitRate,
        reason: line.overrideReason,
        actorId: line.overrideById,
      };
    }
  }
  return {
    ref: line.id,
    label: line.label,
    category: line.category as ServiceLineInput["category"],
    basis: line.basis as ServiceLineInput["basis"],
    currency,
    unitRate,
    quantity: line.quantity,
    participants: line.participants ?? undefined,
    capacity: line.capacity ?? undefined,
    includedElsewhere: line.includedElsewhere,
    isStaffCost: line.isStaffCost,
    override,
    sourceRef,
    vehicleTypeId: line.vehicleTypeId ?? undefined,
    vehicleTypeName: vehicleTypeName ?? undefined,
    serviceProductId: line.serviceProductId ?? undefined,
    date: line.date ?? undefined,
  };
}

/** Policy that deliberately produces a MISSING_POLICY blocker downstream. */
const MISSING_POLICY_INPUT: PolicyInput = { type: "MARKUP_ON_COST", roundingIncrement: "1" };

async function resolvePolicy(): Promise<{ policy: PolicyInput; quoteCurrency: string }> {
  const active = await getActivePolicy();
  if (!active) return { policy: MISSING_POLICY_INPUT, quoteCurrency: "USD" };
  return {
    policy: {
      type: active.type as PolicyType,
      rate: active.rate ?? undefined,
      minProfit: active.minProfit ?? undefined,
      minProfitCurrency: active.minProfitCurrency ?? undefined,
      feeFraction: active.feeFraction ?? undefined,
      roundingIncrement: active.roundingIncrement,
    },
    quoteCurrency: active.quoteCurrency || "USD",
  };
}

export interface BuildEngineInputOptions {
  /** What-if override used by the preview endpoint; never persisted. */
  policyOverride?: PolicyInput;
  /** Quote currency when overriding the policy. Defaults to the policy's. */
  quoteCurrencyOverride?: string;
}

export async function buildEngineInputForVersion(
  versionId: string,
  opts: BuildEngineInputOptions = {},
): Promise<EngineInput> {
  const version = (await prisma.quoteVersion.findUnique({
    where: { id: versionId },
    include: {
      request: true,
      scenarios: { include: { stays: { include: { hotelProduct: true } } } },
      serviceLines: true,
    },
  })) as
    | (QuoteVersion & {
        request: TravelRequest;
        scenarios: (Scenario & { stays: (StaySegment & { hotelProduct: HotelProduct | null })[] })[];
        serviceLines: ServiceLine[];
      })
    | null;

  if (!version) {
    throw new ResolutionError("VERSION_NOT_FOUND", `quote version ${versionId} does not exist`);
  }

  const { policy: resolvedPolicy, quoteCurrency } = await resolvePolicy();
  const policy = opts.policyOverride ?? resolvedPolicy;
  const finalQuoteCurrency = opts.quoteCurrencyOverride ?? quoteCurrency;

  // FX is effective-dated; the tour start date fixes the snapshot's FX map.
  const fxRates = await getFxMap(version.request.startDate as ISODate);

  const travelers = parseTravelers(version.request.travelers);

  const issues: ResolutionIssue[] = [];

  // One rate query for all hotels referenced by this version.
  const hotelIds = Array.from(
    new Set(
      version.scenarios.flatMap((sc) =>
        sc.stays.map((s) => s.hotelProductId).filter((id): id is string => !!id),
      ),
    ),
  );
  const rateRows = hotelIds.length
    ? await prisma.rateVersion.findMany({
        where: { hotelProductId: { in: hotelIds }, productType: "HOTEL", status: "VERIFIED" },
        // Deterministic candidate order: extra-bed attachment and override
        // carry-over must not depend on storage order.
        orderBy: [{ priority: "desc" }, { validFrom: "asc" }, { id: "asc" }],
      })
    : [];
  // NEEDS_REVIEW rates are excluded above: unverified rates are not usable,
  // and their absence surfaces as MISSING_RATE in the engine.
  const ratesByHotel = new Map<string, RateVersion[]>();
  for (const row of rateRows) {
    const list = ratesByHotel.get(row.hotelProductId!) ?? [];
    list.push(row);
    ratesByHotel.set(row.hotelProductId!, list);
  }

  // Same batched load for catalog-linked service lines: VERIFIED SERVICE
  // rates for every serviceProductId referenced by this version's lines.
  const serviceProductIds = Array.from(
    new Set(
      version.serviceLines.map((l) => l.serviceProductId).filter((id): id is string => !!id),
    ),
  );
  const serviceRateRows = serviceProductIds.length
    ? await prisma.rateVersion.findMany({
        where: { serviceProductId: { in: serviceProductIds }, productType: "SERVICE", status: "VERIFIED" },
        orderBy: [{ priority: "desc" }, { validFrom: "asc" }, { id: "asc" }],
      })
    : [];
  const serviceRatesByProduct = new Map<string, RateVersion[]>();
  for (const row of serviceRateRows) {
    const list = serviceRatesByProduct.get(row.serviceProductId!) ?? [];
    list.push(row);
    serviceRatesByProduct.set(row.serviceProductId!, list);
  }

  const sharedLines = version.serviceLines.filter((l) => l.scenarioId === null);

  // Vehicle display names are frozen into the engine input so the internal
  // costing sheet can print "35,000 per Sedan" without a live catalog lookup.
  const lineVehicleIds = Array.from(
    new Set(version.serviceLines.map((l) => l.vehicleTypeId).filter((id): id is string => !!id)),
  );
  const vehicleRows = lineVehicleIds.length
    ? await prisma.vehicleType.findMany({ where: { id: { in: lineVehicleIds } } })
    : [];
  const vehicleNameById = new Map(vehicleRows.map((v) => [v.id, v.name]));

  const scenarios = version.scenarios.map((sc) => {
    const stays: StaySegmentInput[] = sc.stays.map((stay) => ({
      ref: stay.id,
      hotelName: stay.hotelName,
      city: stay.city ?? undefined,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      board: stay.board ?? undefined,
      roomAllocations: normalizeAllocations(stay, stay.hotelProduct),
      rates: resolveStayRates(
        stay,
        stay.hotelProductId ? ratesByHotel.get(stay.hotelProductId) ?? [] : [],
        finalQuoteCurrency,
        issues,
      ),
    }));
    // Lines a template rule marked inactive (nobody eligible) are not part of the quotation at all:
    // not charged, not listed as "included", and not rate-resolved.
    const lines = [...sharedLines, ...version.serviceLines.filter((l) => l.scenarioId === sc.id)].filter((l) => !l.ruleInactive);
    return {
      ref: sc.id,
      label: sc.label,
      tourStart: version.request.startDate,
      tourEnd: version.request.endDate,
      travelers,
      stays,
      services: lines.map((l) =>
        resolveServiceLine(
          l,
          l.serviceProductId ? serviceRatesByProduct.get(l.serviceProductId) ?? [] : [],
          // Day-linked lines price on their own date; unlinked lines fall back
          // to the tour start, the same snapshot date that fixes the FX map.
          l.date ?? version.request.startDate,
          issues,
          l.vehicleTypeId ? vehicleNameById.get(l.vehicleTypeId) : undefined,
        ),
      ),
      // vehicleChecks: intentionally omitted — no version-level vehicle
      // assignment exists in the schema yet (see module docstring).
    };
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new ResolutionError(
      first.code,
      `cannot resolve version ${versionId}: ${issues.map((i) => i.message).join("; ")}`,
      issues,
    );
  }

  return {
    fx: { rates: fxRates, quoteCurrency: finalQuoteCurrency },
    policy,
    scenarios,
    engineVersion: ENGINE_VERSION,
  };
}
