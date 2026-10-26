/**
 * Seeds the travel catalog from the staged workbook evidence (or directly
 * from doc/travel/Workbook-Evidence.json when no batch is staged). Every
 * value comes from an evidence cell — no rates are invented — and provenance
 * is kept as sourceRef/evidenceRef strings like "Tour Calculator!C58".
 *
 * Idempotent: entities are keyed on stable names/cells, so re-running updates
 * in place instead of duplicating. Seasonal free text (L/M columns) is stored
 * as notes only — never parsed into validFrom/validTo (plan §8: "Do not
 * infer a full season from a summary remark").
 *
 * CLI: npx tsx scripts/seed-travel-catalog.ts [path-to-evidence.json]
 */

import { readFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/security/hash";
import {
  isNumeric,
  parseWorkbookEvidence,
  type HotelCatalogRow,
  type ParsedWorkbook,
  type ServiceCatalogRow,
  type WorkbookEvidence,
} from "@/lib/travel/import";
import type { PricingBasis } from "@/lib/travel/contracts";

const DEFAULT_EVIDENCE_PATH = path.join(
  __dirname,
  "..",
  "doc",
  "travel",
  "Workbook-Evidence.json",
);

// ---------------------------------------------------------------------------
// Idempotency helpers (catalog tables have no natural unique keys, so match
// on stable names / evidence cells)
// ---------------------------------------------------------------------------

async function upsertVehicleType(data: { name: string; seats: number; notes: string }) {
  const existing = await prisma.vehicleType.findFirst({ where: { name: data.name } });
  if (existing) return prisma.vehicleType.update({ where: { id: existing.id }, data });
  return prisma.vehicleType.create({ data });
}

/**
 * Fleet vocabulary convergence (Phase: per-vehicle pricing): the catalog was
 * seeded with workbook-era names (Van / Minibus / Large bus); the operator's
 * fleet vocabulary is Sedan / Minivan / Sprinter / Big bus. An old-named row
 * is RENAMED in place (its id — and any rates referencing it — survives). If
 * both old and new names already exist, the new-named row is updated and the
 * stale duplicate is deactivated rather than creating a name collision.
 */
async function convergeVehicleType(target: { name: string; seats: number; notes: string; oldNames: string[] }) {
  const { oldNames, ...data } = target;
  for (const oldName of oldNames) {
    const legacy = await prisma.vehicleType.findFirst({ where: { name: oldName } });
    if (!legacy) continue;
    const renamed = await prisma.vehicleType.findFirst({ where: { name: data.name } });
    if (renamed) {
      await prisma.vehicleType.update({ where: { id: renamed.id }, data });
      if (legacy.id !== renamed.id && legacy.active) {
        await prisma.vehicleType.update({
          where: { id: legacy.id },
          data: { active: false, notes: `Superseded by "${data.name}" (renamed fleet vocabulary)` },
        });
      }
      return renamed;
    }
    return prisma.vehicleType.update({ where: { id: legacy.id }, data });
  }
  return upsertVehicleType(data);
}

async function upsertHotelProduct(data: {
  name: string;
  city: string | null;
  stars: number | null;
  kind: string;
  roomType: string | null;
  capacityAdults: number;
  capacityTotal: number;
  extraBedAllowed: boolean;
  boardOptions: string | null;
  supplierId: string | null;
}) {
  const existing = await prisma.hotelProduct.findFirst({ where: { name: data.name } });
  if (existing) return prisma.hotelProduct.update({ where: { id: existing.id }, data });
  return prisma.hotelProduct.create({ data });
}

async function upsertServiceProduct(data: {
  name: string;
  category: string;
  basis: string;
  capacity: number | null;
  weekdays: string | null;
  language: string | null;
  durationVariant: string | null;
}) {
  const existing = await prisma.serviceProduct.findFirst({ where: { name: data.name } });
  if (existing) return prisma.serviceProduct.update({ where: { id: existing.id }, data });
  return prisma.serviceProduct.create({ data });
}

interface RateKey {
  productType: "HOTEL" | "VEHICLE" | "SERVICE";
  hotelProductId?: string;
  serviceProductId?: string;
  // Part of the identity: per-vehicle SERVICE rows share the product,
  // occupancy and evidenceRef of their base row and must not match it.
  vehicleTypeId?: string;
  occupancy: string | null;
  currency: string;
  evidenceRef: string;
}

interface RateData {
  amount: string | null;
  board?: string | null;
  weekdays?: string | null;
  stopSales?: string | null;
  quoteOnRequest?: boolean;
  priority?: number;
  status: "VERIFIED" | "NEEDS_REVIEW";
  notes: string | null;
  importRowId?: string | null;
}

async function upsertRateVersion(key: RateKey, data: RateData) {
  const where = {
    productType: key.productType,
    hotelProductId: key.hotelProductId ?? null,
    serviceProductId: key.serviceProductId ?? null,
    vehicleTypeId: key.vehicleTypeId ?? null,
    occupancy: key.occupancy,
    currency: key.currency,
    evidenceRef: key.evidenceRef,
  };
  const existing = await prisma.rateVersion.findFirst({ where });
  if (existing) return prisma.rateVersion.update({ where: { id: existing.id }, data });
  return prisma.rateVersion.create({ data: { ...key, ...data } });
}

// ---------------------------------------------------------------------------
// Workbook interpretation
// ---------------------------------------------------------------------------

const WEEKDAY_MAP: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

/** "Wed-Fri-Sun" -> [3,5,7] (ISO weekdays; null when nothing parses). */
function parseWeekdays(note: string | null): number[] | null {
  if (!note) return null;
  const days = note
    .toLowerCase()
    .split(/[^a-z]+/)
    .map((t) => WEEKDAY_MAP[t.slice(0, 3)])
    .filter((d): d is number => d !== undefined);
  return days.length > 0 ? days.sort((a, b) => a - b) : null;
}

function parseStars(name: string): number | null {
  const m = name.match(/^(\d)★/);
  return m ? parseInt(m[1], 10) : null;
}

function parseCity(name: string): string {
  // Catalog names carry the destination as a prefix (e.g. "4★ Dilijan INN");
  // rows without a destination prefix are Yerevan hotels in the workbook.
  if (/tsaghkadzor/i.test(name)) return "Tsaghkadzor";
  if (/dilijan/i.test(name)) return "Dilijan";
  if (/jermuk/i.test(name)) return "Jermuk";
  return "Yerevan";
}

function isCottage(h: HotelCatalogRow): boolean {
  return /\(Cottages\)/.test(h.name);
}

/**
 * Per-hotel evidence conflicts from the agreement gallery (plan §3.1). These
 * are stored source statements, NOT verified availability.
 */
function hotelEvidenceNotes(h: HotelCatalogRow): string[] {
  const notes: string[] = [];
  if (h.note) notes.push(h.note);
  if (/Cozy House/.test(h.name)) {
    // F36 offers an extra bed at 10,000 AMD, but the supplier email at
    // Hotels and Agreements!LY89 says extra beds are not provided.
    notes.push(
      "Evidence conflict: catalog lists extra bed 10000 AMD (Tour Calculator!F36) but Hotels and Agreements!LY89 says no extra beds — needs supplier reconciliation",
    );
  }
  if (/Grand Hotel Yerevan/.test(h.name)) {
    notes.push(
      "Supplier email Hotels and Agreements!GW40: October 2026 closed for sales; May 2026 requires written price offer (quote on request) instead of the standard TA rate — unverified correspondence",
    );
  }
  if (/Teghenis/.test(h.name)) {
    notes.push(
      "Correspondence IS59: cottages exclude breakfast, room bookings include it; IS2 weekend definition is Friday/Saturday (unverified)",
    );
  }
  if (/Grand Resort Jermuk/.test(h.name)) {
    notes.push(
      "Correspondence MW69: no one-night bookings and no group bookings in July/August; commissionable medical package vs non-commissionable breakfast package — needs interpretation (unverified)",
    );
  }
  if (/Radisson Blu/.test(h.name)) {
    notes.push(
      "Agreement IG2: extra bed 10000 AMD is separate from the third person's breakfast 9000 AMD; catalog keeps only one extra-bed amount (unverified)",
    );
  }
  return notes;
}

const GRAND_HOTEL_STOP_SALES = JSON.stringify([
  {
    from: "2026-10-01",
    to: "2026-11-01",
    reason: "Closed for sales per supplier email GW40 (unverified)",
  },
]);

function seasonalNoteText(h: HotelCatalogRow): string | null {
  if (!h.seasonalNote) return null;
  // Free-text seasonality is evidence, not executable validity (plan §3.1).
  return `Seasonality (free text, not parsed into validity): "${h.seasonalNote}"`;
}

async function seedHotels(
  parsed: ParsedWorkbook,
  importRowId: (entityType: string, sourceRef: string) => string | null,
  activated: string[],
) {
  for (const h of parsed.hotels) {
    const cottage = isCottage(h);
    const teghisCottage = cottage && /Teghenis/.test(h.name);
    const cozyHouse = /Cozy House/.test(h.name);
    const notes = hotelEvidenceNotes(h);
    if (cottage && !teghisCottage) {
      notes.push("Cottage capacity not stated in workbook — verify against supplier");
    }

    const product = await upsertHotelProduct({
      name: h.name,
      city: parseCity(h.name),
      stars: parseStars(h.name),
      kind: cottage ? "COTTAGE_UNIT" : "ROOM",
      // M27: "2 rooms, up to 5 pax" for Teghenis cottages
      roomType: teghisCottage ? "Cottage 2BR" : cottage ? "Cottage" : null,
      capacityAdults: teghisCottage ? 5 : 2,
      capacityTotal: teghisCottage ? 5 : 2,
      // Cozy House: evidence conflict LY89 says no extra beds — do not allow.
      // Others: a numeric extra-bed rate is evidence the supplement exists.
      extraBedAllowed: cozyHouse ? false : h.rates.EXTRA_BED !== null && h.rates.EXTRA_BED !== "TBC",
      boardOptions: null,
      supplierId: null,
    });

    const hotelRowId = importRowId("HOTEL", `Tour Calculator!B${h.row}`);
    if (hotelRowId) activated.push(hotelRowId);

    const notesText = [seasonalNoteText(h), ...notes].filter(Boolean).join("\n") || null;
    const isGrandHotel = /Grand Hotel Yerevan/.test(h.name);

    if (cottage) {
      // Whole-unit pricing: collapse C/D/E into one UNIT rate. When the three
      // columns disagree (Elegant, Mariot) the workbook's basis is ambiguous —
      // stage the C value but flag NEEDS_REVIEW instead of guessing.
      const cols = [h.rates.SGL, h.rates.DBL, h.rates.TPL];
      const numeric = cols.filter((v): v is string => isNumeric(v)).map((v) => v.trim());
      const unanimous = numeric.length === 3 && numeric[0] === numeric[1] && numeric[1] === numeric[2];
      const amount = numeric[0] ?? null;
      const unitNotes = [
        `Whole-cottage unit rate; do not multiply by bedrooms (agreement IS2)`,
        unanimous
          ? `C/D/E agree at ${amount} AMD`
          : `Ambiguous per-occupancy vs whole-unit pricing: C=${cols[0] ?? "blank"}, D=${cols[1] ?? "blank"}, E=${cols[2] ?? "blank"} — needs supplier verification`,
        notesText,
      ]
        .filter(Boolean)
        .join("\n");
      await upsertRateVersion(
        {
          productType: "HOTEL",
          hotelProductId: product.id,
          occupancy: "UNIT",
          currency: "AMD",
          evidenceRef: `Tour Calculator!C${h.row}`,
        },
        {
          amount,
          status: unanimous ? "VERIFIED" : "NEEDS_REVIEW",
          notes: unitNotes,
          stopSales: isGrandHotel ? GRAND_HOTEL_STOP_SALES : null,
          importRowId: importRowId("RATE", `Tour Calculator!C${h.row}`),
        },
      );
      const rateRowId = importRowId("RATE", `Tour Calculator!C${h.row}`);
      if (rateRowId) activated.push(rateRowId);

      // Cottages can still sell an extra-bed supplement (F column).
      const rawBed = h.rates.EXTRA_BED;
      const bedNumeric = isNumeric(rawBed);
      await upsertRateVersion(
        {
          productType: "HOTEL",
          hotelProductId: product.id,
          occupancy: "EXTRA_BED",
          currency: "AMD",
          evidenceRef: `Tour Calculator!F${h.row}`,
        },
        {
          amount: bedNumeric ? rawBed!.trim() : null,
          status: bedNumeric ? "VERIFIED" : "NEEDS_REVIEW",
          notes: notesText,
          importRowId: importRowId("RATE", `Tour Calculator!F${h.row}`),
        },
      );
      const bedRowId = importRowId("RATE", `Tour Calculator!F${h.row}`);
      if (bedRowId) activated.push(bedRowId);
    } else {
      for (const { col, occupancy } of [
        { col: "C", occupancy: "SGL" },
        { col: "D", occupancy: "DBL" },
        { col: "E", occupancy: "TPL" },
        { col: "F", occupancy: "EXTRA_BED" },
      ] as const) {
        const raw = h.rates[occupancy];
        const numeric = isNumeric(raw);
        const formula = h.rateFormulas[occupancy];
        const rateNotes = [
          formula
            ? `Formula-derived price (${col}${h.row} ${formula}); cached value stored, commercial meaning unverified (plan §3.1)`
            : null,
          cozyHouse && occupancy === "EXTRA_BED"
            ? "Evidence conflict: Hotels and Agreements!LY89 says no extra beds — do not activate without supplier reconciliation"
            : null,
          // May 2026 sales need a written offer instead of the TA rate
          // (supplier email GW40, unverified) — force quote-on-request.
          isGrandHotel
            ? "May 2026 quote-on-request per supplier email GW40 (unverified)"
            : null,
          notesText,
        ]
          .filter(Boolean)
          .join("\n") || null;
        const needsReview =
          !numeric || (cozyHouse && occupancy === "EXTRA_BED");
        await upsertRateVersion(
          {
            productType: "HOTEL",
            hotelProductId: product.id,
            occupancy,
            currency: "AMD",
            evidenceRef: `Tour Calculator!${col}${h.row}`,
          },
          {
            amount: numeric ? raw!.trim() : null,
            status: needsReview ? "NEEDS_REVIEW" : "VERIFIED",
            notes: rateNotes,
            stopSales: isGrandHotel ? GRAND_HOTEL_STOP_SALES : null,
            quoteOnRequest: isGrandHotel,
            importRowId: importRowId("RATE", `Tour Calculator!${col}${h.row}`),
          },
        );
        const rateRowId = importRowId("RATE", `Tour Calculator!${col}${h.row}`);
        if (rateRowId) activated.push(rateRowId);
      }
    }
  }
}

interface ServiceSpec {
  basis: PricingBasis;
  capacity: number | null;
  weekdays: number[] | null;
  language: string | null;
  durationVariant: string | null;
  note: string | null;
}

function serviceSpec(s: ServiceCatalogRow): ServiceSpec {
  const base: ServiceSpec = {
    basis: "GROUP",
    capacity: null,
    weekdays: null,
    language: null,
    durationVariant: null,
    note: null,
  };
  switch (s.category) {
    case "TRANSPORTATION": {
      // Rows 69:72 are shared group tours sold per seat with fixed departure
      // weekdays in F; the rest are flat per-vehicle-trip prices (plan §3.3).
      if (s.row >= 69 && s.row <= 72) {
        return { ...base, basis: "PER_PERSON", weekdays: parseWeekdays(s.note) };
      }
      return {
        ...base,
        basis: "VEHICLE_TRIP",
        note: "Flat per-vehicle-trip price; workbook does not identify the vehicle class",
      };
    }
    case "TICKETS": {
      if (/chir/i.test(s.name)) {
        // Chir's House: 10,000 AMD per group of up to 5 people (operator rule: 6 pax → 2×).
        return { ...base, basis: "CAPACITY_BLOCK", capacity: 5, note: "10000 AMD per group of up to 5 people (operator rule: 6 pax → 2 groups)" };
      }
      if (/lavash/i.test(s.name)) {
        // Lavash Baking: 10,000 AMD per group of up to 10 people (operator rule: 12 pax → 2×).
        // Mass templates E5:G5 charge the same 10,000 at 2/4/6 PAX: group-priced, not per person.
        return { ...base, basis: "CAPACITY_BLOCK", capacity: 10, note: "10000 AMD per group of up to 10 people (operator rule: 12 pax → 2 groups)" };
      }
      return { ...base, basis: "PER_PERSON" };
    }
    case "EXTRA_SERVICES": {
      if (/jeep/i.test(s.name)) return { ...base, basis: "CAPACITY_BLOCK", capacity: 3 };
      if (/boat/i.test(s.name)) return { ...base, basis: "CAPACITY_BLOCK", capacity: 25 };
      if (/concert/i.test(s.name)) return { ...base, basis: "GROUP" };
      // MasterClass basis is not established by the workbook (plan §3.3).
      return { ...base, basis: "PER_PERSON", note: "Basis uncertain (per person vs per group) — plan §3.3 flags it for capacity/basis rules" };
    }
    case "GUEST_MEALS":
      return { ...base, basis: "PERSON_MEAL" };
    case "GUIDES": {
      const lang =
        s.name.match(/^(English|Russian|Arabic)/)?.[1] ??
        s.name.match(/\(([^)]+)\)$/)?.[1] ??
        null;
      if (/half day/i.test(s.name)) {
        return { ...base, basis: "GUIDE_HALF_DAY", language: lang, durationVariant: "half_day" };
      }
      if (/full day/i.test(s.name)) {
        return { ...base, basis: "GUIDE_DAY", language: lang, durationVariant: "full_day" };
      }
      if (/arrival transfer/i.test(s.name)) {
        return { ...base, basis: "GROUP", language: lang, durationVariant: "transfer" };
      }
      // Local/museum guides charge a flat fee per group (plan §3.3).
      return { ...base, basis: "GROUP", language: lang, note: "Local/museum guide, flat per group" };
    }
    case "STAFF_ACCOMMODATION":
      return { ...base, basis: "ROOM_NIGHT" };
    case "STAFF_MEALS":
      return { ...base, basis: "PERSON_MEAL" };
    case "TOUR_LEADER":
      // Zero rates are legitimate: the leader's costs are guest-covered.
      return { ...base, basis: "PER_PERSON" };
    default:
      return base;
  }
}

async function seedServices(
  parsed: ParsedWorkbook,
  importRowId: (entityType: string, sourceRef: string) => string | null,
  activated: string[],
) {
  for (const s of parsed.services) {
    const spec = serviceSpec(s);
    const product = await upsertServiceProduct({
      name: s.name,
      category: s.category,
      basis: spec.basis,
      capacity: spec.capacity,
      weekdays: spec.weekdays ? JSON.stringify(spec.weekdays) : null,
      language: spec.language,
      durationVariant: spec.durationVariant,
    });
    const notes = [
      s.row === 149
        ? "Misclassified in the workbook's guest-meals block (Tour Calculator row 149); this is a staff meal"
        : null,
      s.note ? `Workbook remark: "${s.note}"` : null,
      spec.note,
      s.amount === "0" ? "Legitimate zero rate in the workbook" : null,
    ]
      .filter(Boolean)
      .join("\n") || null;
    await upsertRateVersion(
      {
        productType: "SERVICE",
        serviceProductId: product.id,
        occupancy: null,
        currency: "AMD",
        evidenceRef: `Tour Calculator!C${s.row}`,
      },
      {
        amount: s.amount,
        status: s.amount !== null ? "VERIFIED" : "NEEDS_REVIEW",
        notes,
        importRowId: importRowId("SERVICE", `Tour Calculator!C${s.row}`),
      },
    );
    const rowId = importRowId("SERVICE", `Tour Calculator!C${s.row}`);
    if (rowId) activated.push(rowId);
  }
}

/**
 * Per-vehicle pricing for transportation tours: every TRANSPORTATION service
 * with a catalog rate gets one SERVICE RateVersion per fleet vehicle type,
 * copying the vehicle-agnostic base rate (same amount/currency/validity) at
 * priority 1 — the base row stays at priority 0 as the fallback for lines
 * without a vehicle selection. Amounts are placeholders equal to the base
 * rate until the operator enters fleet-specific prices in the catalog UI.
 */
async function seedVehicleServiceRates(vehicleTypeIds: string[]) {
  if (vehicleTypeIds.length === 0) return;
  const transportProducts = await prisma.serviceProduct.findMany({
    where: { category: "TRANSPORTATION" },
    include: {
      rates: { where: { productType: "SERVICE", vehicleTypeId: null } },
    },
  });
  for (const product of transportProducts) {
    for (const base of product.rates) {
      for (const vehicleTypeId of vehicleTypeIds) {
        // Idempotent on (product, vehicle, currency, validity band).
        const existing = await prisma.rateVersion.findFirst({
          where: {
            productType: "SERVICE",
            serviceProductId: product.id,
            vehicleTypeId,
            currency: base.currency,
            validFrom: base.validFrom,
            validTo: base.validTo,
          },
        });
        if (existing) continue;
        await prisma.rateVersion.create({
          data: {
            productType: "SERVICE",
            serviceProductId: product.id,
            vehicleTypeId,
            amount: base.amount,
            currency: base.currency,
            validFrom: base.validFrom,
            validTo: base.validTo,
            priority: 1,
            status: "VERIFIED",
            evidenceRef: base.evidenceRef,
            notes: "Same as base rate pending fleet-specific pricing",
          },
        });
      }
    }
  }
}

async function seedGeorgiaBands(
  parsed: ParsedWorkbook,
  importRowId: (entityType: string, sourceRef: string) => string | null,
  activated: string[],
) {
  for (const duration of ["3N/4D", "4N/5D"] as const) {
    const rows = parsed.georgiaBands.filter((g) => g.duration === duration);
    const hotels = Array.from(new Set(rows.map((g) => g.hotel)));
    for (const hotel of hotels) {
      // "3★ Vista hotel or similar" -> "Georgia 4N/5D — Vista hotel or similar (3★)"
      const stars = hotel.match(/^(\d★)\s*/);
      const displayName = stars
        ? `Georgia ${duration} — ${hotel.slice(stars[0].length).trim()} (${stars[1]})`
        : `Georgia ${duration} — ${hotel}`;
      const product = await upsertServiceProduct({
        name: displayName,
        // Supplier fixed package spanning lodging+transport; no single cost
        // category fits, and the engine treats it as a PER_PERSON bundle.
        category: "OTHER",
        basis: "PER_PERSON",
        capacity: null,
        weekdays: null,
        language: null,
        durationVariant: null,
      });
      // One RateVersion per PAX band; priority = band number so rate
      // resolution can pick by band (plan §3.6: 4 PAX Vista 4N = 216 USD PP).
      const bands = rows.filter((g) => g.hotel === hotel).sort((a, b) => a.paxBand - b.paxBand);
      for (let i = 0; i < bands.length; i++) {
        const g = bands[i];
        // Larger groups must never pay MORE per person. Brim/Orion 4N/5D
        // breaks this (D215=331 > C215=327) — flag it instead of activating a
        // price that is almost certainly a workbook typo.
        const prev = i > 0 ? bands[i - 1] : null;
        const nonMonotonic =
          prev !== null && Number(g.amount) > Number(prev.amount);
        await upsertRateVersion(
          {
            productType: "SERVICE",
            serviceProductId: product.id,
            occupancy: null,
            currency: "USD",
            evidenceRef: `Tour Calculator!${g.col}${g.row}`,
          },
          {
            amount: g.amount,
            status: nonMonotonic ? "NEEDS_REVIEW" : "VERIFIED",
            priority: i + 1,
            notes:
              `PAX ${g.paxBand} band (paxBand: ${g.paxBand}); program: ${g.bandHeader}` +
              (nonMonotonic
                ? ` — NON-MONOTONIC: PAX ${g.paxBand} at ${g.amount} USD exceeds PAX ${prev.paxBand} at ${prev.amount} USD (${g.col}${g.row} > ${prev.col}${prev.row}); larger groups should not pay more per person — needs supplier verification`
                : ""),
            importRowId: importRowId("GEORGIA_BAND", `Tour Calculator!${g.col}${g.row}`),
          },
        );
        const rowId = importRowId("GEORGIA_BAND", `Tour Calculator!${g.col}${g.row}`);
        if (rowId) activated.push(rowId);
      }
    }
  }
}

async function seedTemplates(
  parsed: ParsedWorkbook,
  importRowId: (entityType: string, sourceRef: string) => string | null,
  activated: string[],
) {
  for (const t of parsed.templates) {
    const template = await prisma.packageTemplate.upsert({
      where: { code: t.code }, // verbatim, incl. the ARMGG typo (plan §3.6)
      update: { name: t.name },
      create: { code: t.code, name: t.name },
    });
    let provenance = t.provenance;
    if (t.durationNote) provenance += `; ${t.durationNote}`;
    if (/jermuk edition/i.test(t.name) && t.code.startsWith("ARMG")) {
      // Plan §3.6: the group "Jermuk Edition" itineraries contain a Jermuk
      // excursion but no Jermuk overnight. Title preserved verbatim.
      provenance +=
        "; titled 'Jermuk Edition' but the inspected itinerary has no Jermuk overnight — pending review";
    }
    await prisma.templateVersion.upsert({
      where: { templateId_versionNo: { templateId: template.id, versionNo: 1 } },
      update: {
        nights: t.nights,
        days: t.days,
        daysJson: JSON.stringify(
          t.dayNarratives.map((d) => ({ dayOffset: d.day - 1, narrative: d.narrative })),
        ),
        legacyMarkup: t.legacyMarkup,
        provenance,
      },
      create: {
        templateId: template.id,
        versionNo: 1,
        nights: t.nights,
        days: t.days,
        daysJson: JSON.stringify(
          t.dayNarratives.map((d) => ({ dayOffset: d.day - 1, narrative: d.narrative })),
        ),
        legacyMarkup: t.legacyMarkup,
        provenance,
      },
    });
    const rowId = importRowId("TEMPLATE", `Mass Calculation!A${t.headerRow}`);
    if (rowId) activated.push(rowId);
  }
}

// ---------------------------------------------------------------------------
// Settings, FX, policy, demo users
// ---------------------------------------------------------------------------

async function seedSettingsAndUsers() {
  await prisma.travelSettings.upsert({
    where: { id: "default" },
    update: {}, // never clobber admin-adjusted settings on re-run
    create: { id: "default", companyTz: "Asia/Yerevan", documentsDir: "data/documents" },
  });

  // Workbook legacy value (Tour Calculator!K55 = 365 AMD per USD). This is a
  // starting point ONLY and requires admin review before quotations are issued.
  await prisma.fXRateVersion.upsert({
    where: { currency_effectiveFrom: { currency: "USD", effectiveFrom: "2026-01-01" } },
    update: { amdPerUnit: "365" },
    create: { currency: "USD", amdPerUnit: "365", effectiveFrom: "2026-01-01" },
  });

  // Legacy workbook "Margin %" is actually markup on cost (plan §3.4).
  // Imported INACTIVE — an admin must consciously activate a policy.
  const policy = await prisma.pricingPolicyVersion.findFirst({
    where: { name: "Legacy workbook markup 14%" },
  });
  if (!policy) {
    await prisma.pricingPolicyVersion.create({
      data: {
        name: "Legacy workbook markup 14%",
        type: "MARKUP_ON_COST",
        rate: "0.14",
        minProfit: null, // intentionally absent: production floor is a business decision
        roundingIncrement: "1",
        quoteCurrency: "USD",
        active: false,
      },
    });
  }

  // Dev-only demo users for the module workflow. Never for production:
  // skipped when NODE_ENV=production unless SEED_DEMO_USERS=true is explicit.
  const seedDemo =
    process.env.SEED_DEMO_USERS === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.SEED_DEMO_USERS !== "false");
  if (seedDemo) {
    const demoPassword = await hashPassword("travel123");
    for (const u of [
      { email: "advisor1@wacontrol.local", name: "Travel Advisor (demo)", role: "ADVISOR" },
      { email: "validator1@wacontrol.local", name: "Travel Validator (demo)", role: "VALIDATOR" },
    ]) {
      await prisma.user.upsert({
        where: { email: u.email },
        update: { role: u.role },
        create: { ...u, password: demoPassword, phone: null },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SeedSummary {
  vehicles: number;
  hotels: number;
  services: number;
  templates: number;
  ratesByStatus: Record<string, number>;
  activatedImportRows: number;
}

export async function seedTravelCatalog(evidencePath?: string): Promise<SeedSummary> {
  const filePath = evidencePath ?? DEFAULT_EVIDENCE_PATH;
  const evidence = JSON.parse(readFileSync(filePath, "utf8")) as WorkbookEvidence;
  const parsed = parseWorkbookEvidence(evidence);

  // Link back to the staged import when a batch exists (provenance chain
  // ImportRow -> RateVersion), and mark activated rows afterwards.
  const batch = await prisma.importBatch.findFirst({
    orderBy: { createdAt: "desc" },
    include: { rows: true },
  });
  const rowByKey = new Map(
    (batch?.rows ?? []).map((r) => [`${r.entityType}|${r.sourceRef}`, r.id] as const),
  );
  const importRowId = (entityType: string, sourceRef: string) =>
    rowByKey.get(`${entityType}|${sourceRef}`) ?? null;
  const activated: string[] = [];

  // Fleet configuration in the operator's vocabulary (Sedan / Minivan /
  // Sprinter / Big bus); legacy workbook-era names are renamed in place by
  // convergeVehicleType. Seats are historical (hidden-sheet labels, plan §3.3)
  // and must be verified against the fleet.
  const fleetNote = "default configuration, verify against fleet";
  const fleet: { name: string; seats: number; oldNames: string[] }[] = [
    { name: "Sedan", seats: 3, oldNames: [] },
    { name: "Minivan", seats: 5, oldNames: ["Van"] },
    { name: "Sprinter", seats: 12, oldNames: ["Minibus"] },
    { name: "Big bus", seats: 48, oldNames: ["Large bus"] },
  ];
  const vehicleTypes = [];
  for (const v of fleet) {
    vehicleTypes.push(await convergeVehicleType({ ...v, notes: fleetNote }));
  }

  await seedHotels(parsed, importRowId, activated);
  await seedServices(parsed, importRowId, activated);
  await seedGeorgiaBands(parsed, importRowId, activated);
  await seedTemplates(parsed, importRowId, activated);
  await seedVehicleServiceRates(vehicleTypes.map((v) => v.id));
  await seedSettingsAndUsers();

  if (activated.length > 0) {
    await prisma.importRow.updateMany({
      where: { id: { in: activated } },
      data: { status: "ACTIVATED" },
    });
  }

  const rates = await prisma.rateVersion.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return {
    vehicles: await prisma.vehicleType.count(),
    hotels: await prisma.hotelProduct.count(),
    services: await prisma.serviceProduct.count(),
    templates: await prisma.packageTemplate.count(),
    ratesByStatus: Object.fromEntries(rates.map((r) => [r.status, r._count._all])),
    activatedImportRows: activated.length,
  };
}

/**
 * CLI bootstrap-only guard: the seed upserts by name and would resurrect
 * deleted rows and overwrite operator edits, so it must not run against a
 * populated catalog (every deploy used to do this). SEED_FORCE=true is the
 * deliberate escape hatch. The guard lives in the CLI entry, not in
 * seedTravelCatalog(), because the test suites seed throwaway databases
 * through that function.
 */
async function main() {
  if (process.env.SEED_FORCE === "true") {
    console.log("[seed-travel-catalog] SEED_FORCE=true — force mode on, seeding over the existing catalog");
  } else {
    const [vehicles, hotels, services] = await Promise.all([
      prisma.vehicleType.count(),
      prisma.hotelProduct.count(),
      prisma.serviceProduct.count(),
    ]);
    if (vehicles > 0 || hotels > 0 || services > 0) {
      console.log(
        `[seed-travel-catalog] catalog already populated (${vehicles} vehicles, ${hotels} hotels, ${services} services) — skipping seed`,
      );
      console.log("[seed-travel-catalog] set SEED_FORCE=true to reseed anyway");
      return;
    }
  }

  return seedTravelCatalog(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}

const isMain =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main()
    .then(async (s) => {
      if (!s) {
        await prisma.$disconnect();
        return;
      }
      console.log("[seed-travel-catalog] done:");
      console.log(`  vehicle types: ${s.vehicles}`);
      console.log(`  hotel products: ${s.hotels}`);
      console.log(`  service products: ${s.services}`);
      console.log(`  package templates: ${s.templates}`);
      console.log(`  rate versions by status: ${JSON.stringify(s.ratesByStatus)}`);
      console.log(`  import rows activated: ${s.activatedImportRows}`);
      const demoSeeded =
        process.env.SEED_DEMO_USERS === "true" ||
        (process.env.NODE_ENV !== "production" && process.env.SEED_DEMO_USERS !== "false");
      console.log(
        demoSeeded
          ? "  demo users (dev only, password travel123): advisor1@wacontrol.local (ADVISOR), validator1@wacontrol.local (VALIDATOR)"
          : "  demo users: skipped (production; set SEED_DEMO_USERS=true to override)",
      );
      console.log(
        "  NOTE: FX USD=365 and the 14% markup policy are workbook legacy values; the policy is INACTIVE pending admin review.",
      );
      await prisma.$disconnect();
    })
    .catch(async (e) => {
      console.error("[seed-travel-catalog] failed:", e);
      await prisma.$disconnect();
      process.exit(1);
    });
}
