/**
 * Shared contracts for the B2B travel costing & quotation module.
 *
 * This file is the frozen integration contract between the calculation engine,
 * backend workflow, frontend and PDF layers. Changes go through the lead only.
 *
 * Money is ALWAYS a decimal string (e.g. "1864.00") — SQLite has no decimal
 * type and binary floats are not authoritative for money. Dates are local
 * calendar dates "YYYY-MM-DD" (no timezones inside the engine).
 */

export type Money = string;
export type ISODate = string; // "YYYY-MM-DD", destination-local calendar date

// ---------------------------------------------------------------------------
// Roles (User.role remains a plain string; these are the travel-module values)
// ---------------------------------------------------------------------------

export const ROLE_ADMIN = "ADMIN";
export const ROLE_USER = "USER";
export const ROLE_ADVISOR = "ADVISOR";
export const ROLE_VALIDATOR = "VALIDATOR";
/** Agency (B2B partner) login: bound to exactly one Agency, read-only client-facing access. */
export const ROLE_PARTNER = "PARTNER";
/** Roles allowed into the /travel area at all. ADMIN doubles as manager. */
export const TRAVEL_ROLES = [ROLE_ADMIN, ROLE_ADVISOR, ROLE_VALIDATOR] as const;
/** Roles that may grant a below-floor exception (manager authority). */
export const FLOOR_EXCEPTION_ROLES = [ROLE_ADMIN] as const;

// ---------------------------------------------------------------------------
// Workflow statuses
// ---------------------------------------------------------------------------

export const QUOTE_STATUSES = [
  "DRAFT",
  "PENDING_VALIDATION",
  "CHANGES_REQUESTED",
  "APPROVED",
  "ISSUED",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "REJECTED",
  "CANCELLED",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Transitions enforced by lib/travel/workflow.ts. */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["PENDING_VALIDATION", "CANCELLED"],
  PENDING_VALIDATION: ["APPROVED", "CHANGES_REQUESTED", "REJECTED", "DRAFT"], // DRAFT = withdraw
  CHANGES_REQUESTED: ["PENDING_VALIDATION", "CANCELLED"],
  APPROVED: ["ISSUED", "CHANGES_REQUESTED", "EXPIRED", "CANCELLED"],
  ISSUED: ["ACCEPTED", "DECLINED", "EXPIRED"],
  ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  REJECTED: [], // continuing work creates a NEW candidate version
  CANCELLED: [],
};

export const REVIEW_ACTIONS = ["APPROVE", "REQUEST_CHANGES", "REJECT"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Package code: CLIENTSHORT-YYYY-MM-DD-NNNN
// ---------------------------------------------------------------------------

/** e.g. "ACME-2026-09-21-0001". NNNN is minimum 4-digit padding, may grow. */
export const PACKAGE_CODE_PATTERN = /^[A-Z0-9]+-\d{4}-\d{2}-\d{2}-\d{4,}$/;
export const MIN_CODE_SEQ_PADDING = 4;

// ---------------------------------------------------------------------------
// Cost categories (the nine workbook categories plus OTHER)
// ---------------------------------------------------------------------------

export const COST_CATEGORIES = [
  "ACCOMMODATION",
  "TRANSPORTATION",
  "TICKETS",
  "EXTRA_SERVICES",
  "GUEST_MEALS",
  "GUIDES",
  "STAFF_ACCOMMODATION",
  "STAFF_MEALS",
  "TOUR_LEADER",
  "OTHER",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Pricing bases — each basis is a DISTINCT formula in the engine
// ---------------------------------------------------------------------------

export const PRICING_BASES = [
  "PER_PERSON", // rate × eligible participants × occurrences
  "GROUP", // rate × occurrences (charged once per group/event)
  "CAPACITY_BLOCK", // ceil(participants / capacity) × rate × occurrences
  "VEHICLE_TRIP", // rate × vehicles × trips
  "VEHICLE_DAY", // rate × vehicles × days
  "PER_KM", // rate × kilometers
  "GUIDE_DAY", // rate × guides × service days
  "GUIDE_HALF_DAY", // rate × guides × half-days
  "ROOM_NIGHT", // rate × rooms × nights (also used by stay segments)
  "PERSON_MEAL", // rate × participants × occurrences (staff/guest meals)
  "FIXED_PACKAGE", // rate × occurrences (supplier fixed package, e.g. Georgia PP bands use PER_PERSON)
] as const;
export type PricingBasis = (typeof PRICING_BASES)[number];

// ---------------------------------------------------------------------------
// Pricing policy
// ---------------------------------------------------------------------------

export const POLICY_TYPES = ["MARKUP_ON_COST", "GROSS_MARGIN_ON_SALES"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export interface PolicyInput {
  type: PolicyType;
  /** Decimal fraction, e.g. "0.14". Workbook "Margin %" imports as MARKUP_ON_COST. */
  rate?: Money;
  /** Absolute minimum profit PER TRAVELER EXCLUDING INFANTS (v0.15.1; supersedes
   *  the v0.14.0 per-paying-person multiplier), in minProfitCurrency.
   *  floor = cost + minProfit × max(0, adults + children − infants) — `children`
   *  already includes infants (age ≤ infantMaxAge subset). Snapshots frozen before
   *  v0.15.1 keep their per-paying (or pre-v0.14.0 flat per-package) numbers. */
  minProfit?: Money;
  minProfitCurrency?: string;
  /** Revenue-based fee fraction of selling price, e.g. "0.05". Solved via division. */
  feeFraction?: Money;
  /** Round the final sell UP to this increment in quote currency, e.g. "1". */
  roundingIncrement: Money;
  /** Manager exception granted for THIS exact snapshot only. */
  belowFloorExceptionGranted?: boolean;
}

// ---------------------------------------------------------------------------
// FX: fx[currency] = AMD per 1 currency unit; AMD = 1 implicitly
// ---------------------------------------------------------------------------

export const BASE_CURRENCY = "AMD";

export interface FxInput {
  /** Map currency -> "AMD per 1 unit". Must include the quote currency. AMD=1. */
  rates: Record<string, Money>;
  quoteCurrency: string;
}

// ---------------------------------------------------------------------------
// Travelers and rooms
// ---------------------------------------------------------------------------

export interface TravelerSetup {
  adults: number;
  children: number;
  infants: number;
  /** Age of each child at return/check-out (booking.com style); length should equal `children`. */
  childAges?: number[];
  /** Paying travelers (denominator for informational per-person displays). */
  paying: number;
  complimentary: number;
  leaders: number;
  staff: number;
}

export interface RoomAllocationInput {
  /** Physical room category key on the hotel product (e.g. "STANDARD", "COTTAGE_2BR"). */
  roomType: string;
  rooms: number;
  adults: number;
  children: number;
  infants: number;
  extraBeds: number;
  /** Physical capacity of ONE room of this category. */
  capacityAdults: number;
  capacityChildren: number;
  capacityTotal: number;
  extraBedAllowed: boolean;
  /** True when the selected rate (e.g. TPL) already includes the extra bed — no double charge. */
  extraBedIncludedInRate: boolean;
  /** True for cottages/units rented as a whole — never multiply by bedrooms. */
  wholeUnit: boolean;
}

// ---------------------------------------------------------------------------
// Engine inputs: stays
// ---------------------------------------------------------------------------

/** A rate covering a date range [from, to) for one room type/occupancy/board. */
export interface RatePeriod {
  from: ISODate; // inclusive
  to: ISODate; // exclusive
  /** null = unknown/TBC. Unknown on a SELECTED room type with rooms > 0 blocks. */
  rate: Money | null;
  currency: string;
  /** Extra bed supplement per bed-night, if applicable. */
  extraBedRate?: Money | null;
  /** Higher wins on overlap; equal-priority overlap on the same night = AMBIGUOUS_RATE. */
  priority: number;
  /** Provenance, e.g. "RateVersion clx…" or "Tour Calculator!D9". */
  sourceRef?: string;
}

export interface StaySegmentInput {
  ref: string; // stable line id
  hotelName: string;
  city?: string;
  checkIn: ISODate; // inclusive
  checkOut: ISODate; // exclusive
  board?: string;
  roomAllocations: RoomAllocationInput[];
  /** Rate periods per roomType. Engine expands nightly across [checkIn, checkOut). */
  rates: Record<string, RatePeriod[]>;
  /** Mandatory per-night supplements (early check-in, gala dinner, ...). */
  supplements?: { label: string; amount: Money; currency: string }[];
}

// ---------------------------------------------------------------------------
// Engine inputs: service lines
// ---------------------------------------------------------------------------

export interface ServiceLineInput {
  ref: string; // stable line id
  label: string;
  category: CostCategory;
  basis: PricingBasis;
  currency: string;
  /** null = missing rate. Missing on a selected line blocks; a legitimate "0" is valid. */
  unitRate: Money | null;
  /** Occurrences / rooms / vehicles / days / km — meaning depends on basis. */
  quantity: string;
  /** Eligible participants (PER_PERSON, PERSON_MEAL, CAPACITY_BLOCK). */
  participants?: number;
  /** Block capacity (CAPACITY_BLOCK only). */
  capacity?: number;
  /** True when already included in a bundle/board — excluded from charging. */
  includedElsewhere?: boolean;
  /** Staff lines (guide/driver/leader) are never multiplied by guest PAX. */
  isStaffCost?: boolean;
  override?: { originalRate: Money | null; reason: string; actorId: string };
  sourceRef?: string;
  /** Selected fleet vehicle (per-vehicle SERVICE rates); undefined = base rate. */
  vehicleTypeId?: string;
  /** Frozen display name of the selected vehicle (v0.14.0) — the internal
   *  costing sheet prints "35,000 per Sedan" without a live catalog lookup. */
  vehicleTypeName?: string;
  /** Catalog link; echoed into ScenarioResult.lines so editors can key by (product, date, vehicle). */
  serviceProductId?: string;
  /** YYYY-MM-DD of the itinerary day this line is pinned to; undefined = not day-linked. */
  date?: ISODate;
}

// ---------------------------------------------------------------------------
// Vehicle capacity check input (transport validation)
// ---------------------------------------------------------------------------

export interface VehicleCheckInput {
  ref: string;
  label: string;
  /** Usable passenger seats (driver already excluded). */
  passengerSeats: number;
  vehicles: number;
  /** Occupants that need seats: guests + guide + leader. */
  requiredSeats: number;
}

// ---------------------------------------------------------------------------
// Engine I/O
// ---------------------------------------------------------------------------

export const ENGINE_VERSION = "1.0.0";

export interface ScenarioEngineInput {
  ref: string;
  label: string;
  tourStart: ISODate;
  tourEnd: ISODate;
  travelers: TravelerSetup;
  stays: StaySegmentInput[];
  services: ServiceLineInput[];
  vehicleChecks?: VehicleCheckInput[];
  /** Nights explicitly marked self-arranged: "YYYY-MM-DD" list with reason. */
  selfArrangedNights?: { date: ISODate; reason: string }[];
}

export interface EngineInput {
  fx: FxInput;
  policy: PolicyInput;
  scenarios: ScenarioEngineInput[];
  engineVersion: string;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const ISSUE_CODES = [
  "INVALID_DATE",
  "DATE_ORDER",
  "MISSING_RATE",
  "AMBIGUOUS_RATE",
  "MISSING_FX",
  "INVALID_FX",
  "MISSING_POLICY",
  "INVALID_POLICY",
  "INVALID_DENOMINATOR",
  "OCCUPANCY_SHORTFALL",
  "EXTRA_BED_NOT_ALLOWED",
  "CAPACITY_EXCEEDED",
  "NIGHT_GAP",
  "NIGHT_OVERLAP",
  "OUT_OF_TOUR_STAY",
  "SELF_ARRANGED_NO_REASON",
  "BELOW_FLOOR",
  "UNUSED_BEDS",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface EngineIssue {
  code: IssueCode;
  severity: "BLOCKER" | "WARNING";
  /** Scenario ref, then line/stay ref. */
  scenarioRef?: string;
  lineRef?: string;
  field?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Engine output
// ---------------------------------------------------------------------------

export interface CategoryCurrencyTotals {
  /** category -> currency -> decimal-string total (source currency). */
  byCategory: Record<string, Record<string, Money>>;
  /** currency -> converted total in quote currency. */
  costByCurrency: Record<string, Money>;
  /** currency -> total in that SOURCE currency (v0.14.0, for the internal
   *  costing sheet's "Total Net <currency>" rows). Absent in older snapshots —
   *  renderers fall back to summing byCategory. */
  bySourceCurrency?: Record<string, Money>;
  /** Total cost in quote currency. */
  costQuote: Money;
}

export interface NightlyCharge {
  date: ISODate;
  stayRef: string;
  roomType: string;
  rooms: number;
  rate: Money;
  currency: string;
  extraBeds: number;
  extraBedCharge: Money;
  sourceRef?: string;
  /** Night row total (rate × rooms + extra beds) converted; null when FX failed (v0.11.0). */
  amountAmd?: Money | null;
  amountQuote?: Money | null;
}

/** Where a priced line's rate came from — provenance for the cost-visibility UI (v0.11.0). */
export const AMOUNT_SOURCES = ["CATALOG", "MANUAL", "OVERRIDE", "INCLUDED", "MISSING"] as const;
export type AmountSource = (typeof AMOUNT_SOURCES)[number];

/** Per-line net cost in a scenario result, for the owner/validator/admin cost view (v0.11.0). */
export interface ScenarioResultLine {
  ref: string;
  label: string;
  category: CostCategory;
  basis: PricingBasis;
  currency: string;
  unitRate: Money | null;
  quantity: Money;
  participants: number | null;
  amountSource: AmountSource;
  /** Line total in the line's own (source) currency; null when unpriced.
   *  Added v0.14.0 — absent in older snapshots. */
  amount?: Money | null;
  /** Line total converted to AMD; null when the line could not be priced or FX failed. */
  amountAmd: Money | null;
  /** Line total converted to the quote currency; null likewise. */
  amountQuote: Money | null;
  /** Catalog link + day pin, so editors key lines by (product, date, vehicle). */
  serviceProductId?: string;
  date?: ISODate;
  vehicleTypeId?: string;
}

export interface ScenarioResult {
  ref: string;
  label: string;
  valid: boolean;
  issues: EngineIssue[];
  nights: number;
  days: number;
  totals: CategoryCurrencyTotals;
  nightly: NightlyCharge[];
  /** Per-service-line net costs (v0.11.0). Redacted away for non-owner advisors. */
  lines: ScenarioResultLine[];
  /** Policy stage results in quote currency (unrounded). */
  policyTarget: Money | null;
  policyFloor: Money | null;
  unroundedSell: Money;
  roundingAdjustment: Money;
  /** Final authoritative group selling total in quote currency. */
  sell: Money;
  profit: Money;
  /** Actual gross margin as decimal fraction string, null when sell = 0. */
  margin: Money | null;
  /** Informational per-paying-traveler price; null when paying = 0. */
  perPayingPerson: Money | null;
  trace: string[];
}

export interface EngineOutput {
  valid: boolean;
  engineVersion: string;
  scenarios: ScenarioResult[];
  issues: EngineIssue[];
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NOTIFICATION_CHANNELS = ["EMAIL", "WHATSAPP"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DELIVERY_STATUSES = [
  "QUEUED",
  // Internal claim marker while a worker is mid-send; reclaimed to QUEUED
  // after 10 min if the worker dies (see notifications.ts).
  "SENDING",
  "SENT",
  "FAILED",
  "SKIPPED_NO_DESTINATION",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const WORKFLOW_EVENT_TYPES = [
  "SUBMITTED",
  "RESUBMITTED",
  "CHANGES_REQUESTED",
  "REJECTED",
  "APPROVED",
  "ISSUED",
  "REASSIGNED",
  "VALIDATION_OVERDUE",
  "OUTCOME_RECORDED",
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/** Fields every notification body must carry. */
export interface NotificationPayload {
  packageCode: string;
  clientShort: string;
  versionLabel: string; // e.g. "v02"
  event: WorkflowEventType;
  actorName: string;
  action?: string; // required action, if any
  reason?: string;
  dueAt?: string;
  link: string; // authenticated app link
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Rate / import statuses
// ---------------------------------------------------------------------------

export const RATE_STATUSES = ["NEEDS_REVIEW", "VERIFIED", "ARCHIVED"] as const;
export type RateStatus = (typeof RATE_STATUSES)[number];

export const IMPORT_ROW_STATUSES = [
  "STAGED",
  "VERIFIED",
  "ACTIVATED",
  "REJECTED",
  "ERROR",
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

// ---------------------------------------------------------------------------
// Itinerary day services
// ---------------------------------------------------------------------------

/**
 * One service entry on an itinerary day. `serviceProductId` links the entry to
 * the catalog (a day-linked ServiceLine is kept in sync server-side); null =
 * free-text entry. `vehicleTypeId` records the selected fleet vehicle for
 * vehicle-priced services (per-vehicle SERVICE rates).
 */
export interface DayServiceItem {
  serviceProductId: string | null;
  label: string;
  /** Long description shown on the client quotation (v0.14.0) — the catalog
   *  ServiceProduct.details at pick time. The label stays the short title. */
  details?: string | null;
  vehicleTypeId?: string | null;
  /** Times the service is consumed (e.g. 2 ticket groups); defaults to 1. v0.11.0. */
  quantity?: number;
}

/**
 * Parses the ItineraryDay.services JSON column. Legacy rows stored plain
 * string arrays; those normalize to `{ serviceProductId: null, label }`.
 * Unparseable or malformed entries are dropped — this column is display data,
 * never a pricing input.
 */
export function normalizeDayServices(json: string | null | undefined): DayServiceItem[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DayServiceItem[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ serviceProductId: null, label: item });
    } else if (item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string") {
      const pid = (item as { serviceProductId?: unknown }).serviceProductId;
      const vid = (item as { vehicleTypeId?: unknown }).vehicleTypeId;
      const qty = (item as { quantity?: unknown }).quantity;
      const det = (item as { details?: unknown }).details;
      out.push({
        serviceProductId: typeof pid === "string" && pid ? pid : null,
        label: (item as { label: string }).label,
        ...(typeof det === "string" && det ? { details: det } : {}),
        ...(typeof vid === "string" && vid ? { vehicleTypeId: vid } : {}),
        ...(typeof qty === "number" && Number.isInteger(qty) && qty >= 1 ? { quantity: qty } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

export function isTravelRole(role: string | undefined): boolean {
  return !!role && (TRAVEL_ROLES as readonly string[]).includes(role);
}

export function canGrantFloorException(role: string | undefined): boolean {
  return !!role && (FLOOR_EXCEPTION_ROLES as readonly string[]).includes(role);
}

/** "v01", "v02", … */
export function versionLabel(versionNo: number): string {
  return `v${String(versionNo).padStart(2, "0")}`;
}
