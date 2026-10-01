/**
 * Client-side view models for the travel module API responses.
 * Field shapes mirror the Prisma models and route payloads; JSON-string
 * columns (travelers, destinations, allocations, resultJson, ...) stay
 * strings here and are parsed at render time.
 */

import type { TraceRow } from "@/lib/travel/trace-table";

export interface TravelUser {
  id: string;
  email: string;
  name: string | null;
  role?: string;
  phone?: string | null;
}

export interface Agency {
  id: string;
  shortCode: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  active: boolean;
  createdAt?: string;
}

export interface RequestListItem {
  id: string;
  packageCode: string;
  title: string;
  status: string;
  startDate: string;
  endDate: string;
  createdAt: string;
  updatedAt: string;
  agency: { id: string; shortCode: string; name: string };
  owner: TravelUser;
  validator: TravelUser | null;
  versions: { id: string; versionNo: number; status: string; createdAt: string }[];
}

export interface StayDetail {
  id: string;
  scenarioId: string;
  hotelProductId: string | null;
  hotelName: string;
  city: string | null;
  checkIn: string;
  checkOut: string;
  board: string | null;
  allocations: string; // JSON RoomAllocationInput[]
  rateOverrides: string | null;
}

export interface ScenarioDetail {
  id: string;
  versionId: string;
  label: string;
  valid: boolean;
  resultJson: string | null; // JSON ScenarioResult
  /** Frozen calculation breakdown (v0.15.0) — present on submitted versions
   *  for viewers who may see full costing; undefined otherwise. */
  traceRows?: TraceRow[];
  stays: StayDetail[];
}

export interface ItineraryDayDetail {
  id: string;
  versionId: string;
  dayOffset: number;
  date: string;
  narrative: string | null;
  overnightCity: string | null;
  services: string | null; // JSON DayServiceItem[] (legacy rows may hold string[])
}

export interface ServiceLineDetail {
  id: string;
  versionId: string;
  scenarioId: string | null;
  category: string;
  label: string;
  basis: string;
  currency: string;
  unitRate: string | null;
  quantity: string;
  participants: number | null;
  capacity: number | null;
  includedElsewhere: boolean;
  isStaffCost: boolean;
  overrideRate: string | null;
  overrideReason: string | null;
  overrideById: string | null;
  sourceRef: string | null;
  serviceProductId: string | null; // catalog link; rate resolves from SERVICE RateVersions
  date: string | null; // YYYY-MM-DD of the itinerary day that spawned the line
  vehicleTypeId: string | null; // selected fleet vehicle; per-vehicle SERVICE rate resolves for it
}

export interface SnapshotSummary {
  id: string;
  hash: string;
  engineVersion: string;
  createdAt: string;
}

export interface DecisionDetail {
  id: string;
  versionId: string;
  snapshotHash: string;
  action: string;
  reason: string | null;
  actorId: string;
  createdAt: string;
}

export interface DocumentDetail {
  id: string;
  kind: string;
  snapshotHash: string;
  templateVersion: string;
  idempotencyKey: string;
  issuedAt: string | null;
  createdAt: string;
  sha256: string | null;
  renderState: "PENDING" | "FAILED" | "READY";
}

export interface VersionDetail {
  id: string;
  requestId: string;
  versionNo: number;
  status: string;
  /** Quote currency bound to this version (from the snapshot), null pre-submit. */
  quoteCurrency: string | null;
  terms: string | null;
  validUntil: string | null;
  templateVersionId: string | null;
  submittedById: string | null;
  submittedAt: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  outcomeScenarioId: string | null;
  createdAt: string;
  scenarios: ScenarioDetail[];
  itineraryDays: ItineraryDayDetail[];
  serviceLines: ServiceLineDetail[];
  snapshot: SnapshotSummary | null;
  decisions: DecisionDetail[];
  documents: DocumentDetail[];
}

export interface AssignmentDetail {
  id: string;
  requestId: string;
  validatorId: string;
  assignedById: string;
  dueAt: string | null;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  validator: TravelUser;
}

export interface TravelRequestDetail {
  id: string;
  packageCode: string;
  agencyId: string;
  agencyRef: string | null;
  ownerId: string;
  title: string;
  destinations: string | null; // JSON string[]
  startDate: string;
  endDate: string;
  travelers: string; // JSON TravelerSetup
  roomPrefs: string | null;
  flightDetails: string | null;
  notes: string | null;
  status: string;
  revision: number;
  currentValidatorId: string | null;
  createdAt: string;
  updatedAt: string;
  agency: Agency;
  owner: TravelUser;
  validator: TravelUser | null;
  versions: VersionDetail[];
  assignments: AssignmentDetail[];
}

export interface TravelerSetupView {
  adults: number;
  children: number;
  infants: number;
  childAges?: number[];
  paying: number;
  complimentary: number;
  leaders: number;
  staff: number;
}

export interface HotelProductView {
  id: string;
  name: string;
  city: string | null;
  country: string;
  stars: number | null;
  kind: string;
  roomType: string | null;
  capacityAdults: number;
  capacityChildren: number;
  capacityTotal: number;
  beds: string | null;
  extraBedAllowed: boolean;
  cotAllowed: boolean;
  boardOptions: string | null; // JSON string[]
  active: boolean;
  supplier: { id: string; name: string } | null;
  rates: RateView[];
}

export interface ServiceProductView {
  id: string;
  name: string;
  details: string | null; // long client-facing description (v0.14.0); name is the short title
  category: string;
  basis: string;
  capacity: number | null;
  weekdays: string | null; // JSON number[] (ISO weekdays 1..7)
  language: string | null;
  durationVariant: string | null;
  active: boolean;
  supplier: { id: string; name: string } | null;
  rates: RateView[];
}

export interface SupplierOption {
  id: string;
  name: string;
}

export interface VehicleTypeView {
  id: string;
  name: string;
  seats: number;
}

export interface RateView {
  id: string;
  productType: string;
  hotelProductId: string | null;
  vehicleTypeId: string | null;
  serviceProductId: string | null;
  amount: string | null;
  currency: string;
  occupancy: string | null;
  board: string | null;
  validFrom: string | null;
  validTo: string | null;
  weekdays: string | null; // JSON number[] (ISO weekdays 1..7)
  minStay: number | null;
  quoteOnRequest: boolean;
  priority: number;
  status: string;
  evidenceRef: string | null;
  notes: string | null;
  createdAt: string;
  hotelProduct?: { id: string; name: string; city: string | null } | null;
  vehicleType?: { id: string; name: string } | null;
  serviceProduct?: { id: string; name: string } | null;
}

export interface FxVersionView {
  id: string;
  currency: string;
  amdPerUnit: string;
  effectiveFrom: string;
  createdAt: string;
}

export interface PolicyView {
  id: string;
  name: string;
  type: string;
  rate: string | null;
  minProfit: string | null;
  minProfitCurrency: string | null;
  feeFraction: string | null;
  roundingIncrement: string;
  quoteCurrency: string;
  allowBelowFloorException: boolean;
  active: boolean;
  createdAt: string;
}

export interface TravelSettingsView {
  id: string;
  companyTz: string;
  defaultPolicyId: string | null;
  requireSettingsForIssue: boolean;
  overdueReminderHours: number | null;
  escalationUserId: string | null;
  documentsDir: string;
  companyName: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyAddress: string | null;
  companyWebsite: string | null;
  brandColor: string | null;
  validatorGroupJid: string | null;
  infantMaxAge: number;
  /** JSON array of user ids — the virtual validator group. */
  validatorUserIds: string;
  /** W3: WhatsAppAccount.key that all travel-module WhatsApp sends use. */
  whatsappAccountKey: string;
  updatedAt: string;
}

export interface TemplateVersionView {
  id: string;
  templateId: string;
  versionNo: number;
  nights: number;
  days: number;
  daysJson: string;
  scenariosJson: string | null;
  legacyMarkup: string | null;
  provenance: string | null;
  status: string;
  createdAt: string;
}

export interface TemplateView {
  id: string;
  code: string;
  name: string;
  versions: TemplateVersionView[];
}

export interface ImportBatchView {
  id: string;
  sourceHash: string;
  fileName: string;
  status: string;
  createdAt: string;
  rowCount: number;
  counts: Record<string, number>;
}

export interface ImportRowView {
  id: string;
  batchId: string;
  entityType: string;
  sourceRef: string;
  status: string;
  issueText: string | null;
}

export interface NotificationDeliveryView {
  id: string;
  channel: string;
  destination: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  body: string;
  sentAt: string | null;
  createdAt: string;
  event: { id: string; type: string; requestId: string; versionId: string | null; createdAt: string };
}
