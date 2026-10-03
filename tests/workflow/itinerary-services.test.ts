/**
 * Itinerary-day → catalog-linked ServiceLine sync (Phase 3): day services with
 * a serviceProductId are mirrored as shared ServiceLine rows (one per
 * product+date pair) inside saveVersionContent, so resolve.ts can price them
 * from SERVICE RateVersions. Manual lines and scenario-bound lines are never
 * touched; unknown/inactive products are rejected with 400.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient, ServiceLine } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import {
  END_DATE,
  START_DATE,
  Fixtures,
  actorOf,
  createRequestInput,
  dblAllocation,
  saveContent,
  scenarioContent,
  seedFixtures,
} from "./fixtures";
import { normalizeDayServices } from "@/lib/travel/contracts";

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let workflow: typeof import("@/lib/travel/workflow");
let fx: Fixtures;

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
});

async function makeProduct(
  name: string,
  opts: { active?: boolean; capacity?: number; category?: string; basis?: string } = {},
) {
  return prisma.serviceProduct.create({
    data: {
      name,
      category: opts.category ?? "GUIDES",
      basis: opts.basis ?? "GUIDE_DAY",
      capacity: opts.capacity ?? null,
      language: "en",
      durationVariant: "full_day",
      active: opts.active ?? true,
    },
  });
}

async function draftRequest() {
  return workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
}

async function linkedLines(versionId: string) {
  return prisma.serviceLine.findMany({ where: { versionId, serviceProductId: { not: null } } });
}

// Return type is `any` on purpose: the schema accepts legacy string items via
// z.preprocess, but z.infer exposes only the normalized output shape.
function day(offset: number, services: unknown[] = []): any {
  return {
    dayOffset: offset,
    date: `2026-10-0${offset + 1}`,
    narrative: `Day ${offset + 1}`,
    overnightCity: "Yerevan",
    services,
  };
}

describe("normalizeDayServices", () => {
  it("normalizes legacy string arrays to { serviceProductId: null, label }", () => {
    expect(normalizeDayServices('["City tour","Museum"]')).toEqual([
      { serviceProductId: null, label: "City tour" },
      { serviceProductId: null, label: "Museum" },
    ]);
  });

  it("round-trips structured items and drops junk", () => {
    expect(
      normalizeDayServices(
        JSON.stringify([{ serviceProductId: "p1", label: "Guide" }, { label: "Lunch" }, 42, null, { nope: 1 }]),
      ),
    ).toEqual([
      { serviceProductId: "p1", label: "Guide" },
      { serviceProductId: null, label: "Lunch" },
    ]);
    expect(normalizeDayServices(null)).toEqual([]);
    expect(normalizeDayServices("not json")).toEqual([]);
    expect(normalizeDayServices('{"a":1}')).toEqual([]);
  });
});

describe("itinerary save → linked service line sync", () => {
  it("creates a linked line per (product, date) with fields copied from the product", async () => {
    const product = await makeProduct("City tour guide", { capacity: 15 });
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }]), day(1)],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      label: "City tour guide",
      category: "GUIDES",
      basis: "GUIDE_DAY",
      capacity: 15,
      quantity: "1",
      currency: "AMD",
      unitRate: null, // priced from the catalog band at resolve time
      scenarioId: null, // shared across scenarios
      serviceProductId: product.id,
      date: "2026-10-01",
    });
  });

  it("creates one line per date when the same product appears on multiple days", async () => {
    const product = await makeProduct("Multi-day guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [
        day(0, [{ serviceProductId: product.id, label: product.name }]),
        day(1, [{ serviceProductId: product.id, label: product.name }]),
      ],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.date))).toEqual(new Set(["2026-10-01", "2026-10-02"]));
  });

  it("updates the date when the product moves to a different day", async () => {
    const product = await makeProduct("Moving guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }]), day(1)],
    });
    const [before] = await linkedLines(version.id);
    expect(before.date).toBe("2026-10-01");

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0), day(1, [{ serviceProductId: product.id, label: product.name }])],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    // Retargeted, not recreated — the line id (and any manual edits) survives.
    expect(lines[0].id).toBe(before.id);
    expect(lines[0].date).toBe("2026-10-02");
  });

  it("deletes linked lines no longer present in any day", async () => {
    const product = await makeProduct("Removable guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
    });
    expect(await linkedLines(version.id)).toHaveLength(1);

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ label: "free-text only" }])],
    });
    expect(await linkedLines(version.id)).toHaveLength(0);
  });

  it("rejects unknown and inactive products with 400", async () => {
    const inactive = await makeProduct("Retired guide", { active: false });
    const { request, version } = await draftRequest();

    await expect(
      saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
        itineraryDays: [day(0, [{ serviceProductId: "does-not-exist", label: "Ghost" }])],
      }),
    ).rejects.toMatchObject({ code: "SERVICE_PRODUCT_UNKNOWN", httpStatus: 400 });

    await expect(
      saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
        itineraryDays: [day(0, [{ serviceProductId: inactive.id, label: inactive.name }])],
      }),
    ).rejects.toMatchObject({ code: "SERVICE_PRODUCT_INACTIVE", httpStatus: 400 });

    expect(await linkedLines(version.id)).toHaveLength(0);
  });

  it("never touches manual or scenario-bound lines", async () => {
    const product = await makeProduct("Synced guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      scenarios: [
        {
          key: "A",
          label: "Option A",
          stays: [
            {
              hotelProductId: fx.hotel.id,
              hotelName: fx.hotel.name,
              city: "Yerevan",
              checkIn: START_DATE,
              checkOut: END_DATE,
              allocations: [dblAllocation()],
            },
          ],
        },
      ],
      serviceLines: [
        {
          scenarioKey: null,
          category: "TICKETS",
          label: "Manual tickets",
          basis: "GROUP",
          currency: "AMD",
          unitRate: "5000",
          quantity: "1",
          includedElsewhere: false,
          isStaffCost: false,
        },
        {
          scenarioKey: "A",
          category: "GUIDES",
          label: "Scenario guide",
          basis: "GUIDE_DAY",
          currency: "AMD",
          unitRate: "30000",
          quantity: "1",
          includedElsewhere: false,
          isStaffCost: false,
        },
      ],
    });

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
    });

    const all = await prisma.serviceLine.findMany({ where: { versionId: version.id }, orderBy: { label: "asc" } });
    expect(all.map((l) => l.label)).toEqual(["Manual tickets", "Scenario guide", "Synced guide"]);
    expect(all.find((l) => l.label === "Manual tickets")).toMatchObject({
      serviceProductId: null,
      unitRate: "5000",
      scenarioId: null,
    });
    expect(all.find((l) => l.label === "Scenario guide")?.scenarioId).not.toBeNull();
  });

  it("invalidates the snapshot when linked lines change, but not on narrative-only edits", async () => {
    const product = await makeProduct("Snapshot guide");
    const { request, version } = await draftRequest();

    const putSnapshot = () =>
      prisma.calculationSnapshot.create({
        data: {
          versionId: version.id,
          inputsJson: "{}",
          resultJson: "{}",
          engineVersion: "test",
          hash: `hash-${Math.random().toString(36).slice(2)}`,
        },
      });
    const snapshotOf = () => prisma.calculationSnapshot.findUnique({ where: { versionId: version.id } });

    // Linked-line change → snapshot gone.
    await putSnapshot();
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
    });
    expect(await snapshotOf()).toBeNull();

    // Same linked services, narrative only → snapshot kept.
    await putSnapshot();
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [
        { ...day(0, [{ serviceProductId: product.id, label: product.name }]), narrative: "rewritten" },
      ],
    });
    expect(await snapshotOf()).not.toBeNull();
  });

  it("stores legacy string services normalized to item objects", async () => {
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, ["City tour", "Museum"])],
    });

    const stored = await prisma.itineraryDay.findFirst({ where: { versionId: version.id } });
    expect(normalizeDayServices(stored!.services)).toEqual([
      { serviceProductId: null, label: "City tour" },
      { serviceProductId: null, label: "Museum" },
    ]);
    // Legacy strings create no service lines.
    expect(await linkedLines(version.id)).toHaveLength(0);
  });
});

/** Echoes the version's current service lines the way the Scenarios tab does. `any[]` because the schema narrows category/basis to enum literals. */
function echoLines(lines: ServiceLine[], patch: Record<string, unknown> = {}): any[] {
  return lines.map((l) => ({
    scenarioKey: l.scenarioId,
    category: l.category,
    label: l.label,
    basis: l.basis,
    currency: l.currency,
    unitRate: l.unitRate,
    quantity: l.quantity,
    participants: l.participants,
    capacity: l.capacity,
    includedElsewhere: l.includedElsewhere,
    isStaffCost: l.isStaffCost,
    overrideRate: l.overrideRate,
    overrideReason: l.overrideReason,
    sourceRef: l.sourceRef,
    serviceProductId: l.serviceProductId,
    date: l.date,
    vehicleTypeId: l.vehicleTypeId,
    ...patch,
  }));
}

describe("scenario saves round-trip linked lines", () => {
  it("a scenario-only save (no itineraryDays) preserves the linked line's catalog link and date", async () => {
    const product = await makeProduct("Round-trip guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
      serviceLines: [
        {
          scenarioKey: null,
          category: "TICKETS",
          label: "Manual tickets",
          basis: "GROUP",
          currency: "AMD",
          unitRate: "5000",
          quantity: "1",
          includedElsewhere: false,
          isStaffCost: false,
        },
      ],
    });

    // Simulate a Scenarios-tab save: scenarios + echoed lines, NO itineraryDays.
    const existing = await prisma.serviceLine.findMany({ where: { versionId: version.id } });
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
      serviceLines: echoLines(existing),
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    // The recreate path assigns a fresh row id (pre-existing delete-many
    // semantics for this endpoint) — the catalog link is what must survive.
    expect(lines[0]).toMatchObject({
      serviceProductId: product.id,
      date: "2026-10-01",
      label: "Round-trip guide",
      unitRate: null,
      scenarioId: null,
    });
    // Manual lines survive too.
    const manual = await prisma.serviceLine.findFirst({ where: { versionId: version.id, serviceProductId: null } });
    expect(manual).toMatchObject({ label: "Manual tickets", unitRate: "5000" });
  });

  it("a quantity edit from the scenarios tab sticks on a linked line", async () => {
    const product = await makeProduct("Qty guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
    });

    const existing = await prisma.serviceLine.findMany({ where: { versionId: version.id } });
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
      serviceLines: echoLines(existing, { quantity: "2" }),
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ serviceProductId: product.id, date: "2026-10-01", quantity: "2" });
  });

  it("rejects a bogus serviceProductId in a serviceLines payload with 400", async () => {
    const { request, version } = await draftRequest();

    await expect(
      saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
        serviceLines: [
          {
            scenarioKey: null,
            category: "GUIDES",
            label: "Ghost guide",
            basis: "GUIDE_DAY",
            currency: "AMD",
            unitRate: null,
            quantity: "1",
            includedElsewhere: false,
            isStaffCost: false,
            serviceProductId: "does-not-exist",
            date: "2026-10-01",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "SERVICE_PRODUCT_UNKNOWN", httpStatus: 400 });
  });
});

describe("vehicle-scoped day services", () => {
  let sedanId: string;
  let minivanId: string;

  beforeAll(async () => {
    sedanId = (await prisma.vehicleType.create({ data: { name: "Sync Sedan", seats: 3 } })).id;
    minivanId = (await prisma.vehicleType.create({ data: { name: "Sync Minivan", seats: 5 } })).id;
  });

  const makeTransfer = (name: string) =>
    makeProduct(name, { category: "TRANSPORTATION", basis: "VEHICLE_TRIP" });

  it("a day item with vehicleTypeId creates a linked line stamped with the vehicle", async () => {
    const product = await makeTransfer("Airport arrival");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId }])],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      serviceProductId: product.id,
      date: "2026-10-01",
      vehicleTypeId: sedanId,
      basis: "VEHICLE_TRIP",
    });
  });

  it("the same product on the same day with two vehicles yields two lines", async () => {
    const product = await makeTransfer("Two-vehicle tour");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [
        day(0, [
          { serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId },
          { serviceProductId: product.id, label: product.name, vehicleTypeId: minivanId },
        ]),
      ],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((l) => l.vehicleTypeId))).toEqual(new Set([sedanId, minivanId]));
  });

  it("changing the vehicle on the same day retargets the existing line", async () => {
    const product = await makeTransfer("Vehicle change tour");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId }])],
    });
    const [before] = await linkedLines(version.id);
    expect(before.vehicleTypeId).toBe(sedanId);

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: minivanId }])],
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    // Updated, not recreated — the line id (and any manual edits) survives.
    expect(lines[0].id).toBe(before.id);
    expect(lines[0].vehicleTypeId).toBe(minivanId);
  });

  it("moving one of two vehicles to another day keeps the other's line untouched", async () => {
    const product = await makeTransfer("Split-vehicle tour");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [
        day(0, [
          { serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId },
          { serviceProductId: product.id, label: product.name, vehicleTypeId: minivanId },
        ]),
        day(1),
      ],
    });
    const before = await linkedLines(version.id);
    const minivanLine = before.find((l) => l.vehicleTypeId === minivanId)!;
    const sedanLine = before.find((l) => l.vehicleTypeId === sedanId)!;

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [
        day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId }]),
        day(1, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: minivanId }]),
      ],
    });

    const after = await linkedLines(version.id);
    expect(after).toHaveLength(2);
    expect(after.find((l) => l.id === sedanLine.id)).toMatchObject({ date: "2026-10-01", vehicleTypeId: sedanId });
    // The same-vehicle line is preferred for the move — ids don't swap.
    expect(after.find((l) => l.id === minivanLine.id)).toMatchObject({ date: "2026-10-02", vehicleTypeId: minivanId });
  });

  it("rejects a bogus vehicleTypeId with 400", async () => {
    const product = await makeTransfer("Ghost vehicle tour");
    const { request, version } = await draftRequest();

    await expect(
      saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
        itineraryDays: [
          day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: "does-not-exist" }]),
        ],
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_TYPE_UNKNOWN", httpStatus: 400 });

    await expect(
      saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
        serviceLines: [
          {
            scenarioKey: null,
            category: "TRANSPORTATION",
            label: "Ghost vehicle line",
            basis: "VEHICLE_TRIP",
            currency: "AMD",
            unitRate: null,
            quantity: "1",
            includedElsewhere: false,
            isStaffCost: false,
            vehicleTypeId: "does-not-exist",
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_TYPE_UNKNOWN", httpStatus: 400 });

    expect(await linkedLines(version.id)).toHaveLength(0);
  });

  it("a scenario-save round-trips vehicleTypeId on linked lines", async () => {
    const product = await makeTransfer("Round-trip transfer");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId }])],
    });

    const existing = await prisma.serviceLine.findMany({ where: { versionId: version.id } });
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
      serviceLines: echoLines(existing),
    });

    const lines = await linkedLines(version.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      serviceProductId: product.id,
      date: "2026-10-01",
      vehicleTypeId: sedanId,
    });
  });

  it("createRevision copies the vehicle selection onto the new version's lines", async () => {
    const product = await makeTransfer("Revision transfer");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId }])],
    });

    await prisma.quoteVersion.update({ where: { id: version.id }, data: { status: "REJECTED" } });
    const v2 = await workflow.createRevision(actorOf(fx.advisor), request.id);

    const lines = await prisma.serviceLine.findMany({ where: { versionId: v2.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ serviceProductId: product.id, vehicleTypeId: sedanId });

    const days = await prisma.itineraryDay.findMany({ where: { versionId: v2.id } });
    expect(normalizeDayServices(days[0].services)).toEqual([
      { serviceProductId: product.id, label: product.name, vehicleTypeId: sedanId },
    ]);
  });
});

describe("createRevision", () => {
  it("preserves catalog links and dates on copied service lines", async () => {
    const product = await makeProduct("Revision guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      itineraryDays: [day(0, [{ serviceProductId: product.id, label: product.name }])],
    });

    // createRevision requires a revisable status; jump there directly.
    await prisma.quoteVersion.update({ where: { id: version.id }, data: { status: "REJECTED" } });
    const v2 = await workflow.createRevision(actorOf(fx.advisor), request.id);

    const lines = await prisma.serviceLine.findMany({ where: { versionId: v2.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      serviceProductId: product.id,
      date: "2026-10-01",
      label: "Revision guide",
      unitRate: null,
    });

    const days = await prisma.itineraryDay.findMany({ where: { versionId: v2.id } });
    expect(normalizeDayServices(days[0].services)).toEqual([{ serviceProductId: product.id, label: product.name }]);
  });
});

describe("submit → document freeze", () => {
  it("freezes normalized itinerary days into displayJson for the issued PDF", async () => {
    const product = await makeProduct("Freeze guide");
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
      itineraryDays: [
        day(0, [{ serviceProductId: product.id, label: product.name }]),
        day(1, ["Free-text walk"]),
      ],
    });
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    await workflow.submit(actorOf(fx.advisor), request.id);

    const snap = await prisma.calculationSnapshot.findUnique({ where: { versionId: version.id } });
    const frozen = JSON.parse(snap!.displayJson!);
    expect(frozen.itineraryDays).toEqual([
      {
        dayOffset: 0,
        date: "2026-10-01",
        narrative: "Day 1",
        overnightCity: "Yerevan",
        services: [{ serviceProductId: product.id, label: "Freeze guide" }],
      },
      {
        dayOffset: 1,
        date: "2026-10-02",
        narrative: "Day 2",
        overnightCity: "Yerevan",
        services: [{ serviceProductId: null, label: "Free-text walk" }],
      },
    ]);
  });

  it("freezes company branding into displayJson for the issued PDF", async () => {
    await prisma.travelSettings.upsert({
      where: { id: "default" },
      update: {
        companyName: "Nare Travel & Tours",
        companyPhone: "+374 10 530053",
        companyEmail: "info@naretravel.am",
        companyAddress: "15 Abovyan St, Yerevan, Armenia",
        companyWebsite: "www.naretravel.am",
        brandColor: "#0d4f8b",
      },
      create: {
        id: "default",
        companyName: "Nare Travel & Tours",
        companyPhone: "+374 10 530053",
        companyEmail: "info@naretravel.am",
        companyAddress: "15 Abovyan St, Yerevan, Armenia",
        companyWebsite: "www.naretravel.am",
        brandColor: "#0d4f8b",
      },
    });
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
    });
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    await workflow.submit(actorOf(fx.advisor), request.id);

    const snap = await prisma.calculationSnapshot.findUnique({ where: { versionId: version.id } });
    const frozen = JSON.parse(snap!.displayJson!);
    expect(frozen.branding).toEqual({
      companyName: "Nare Travel & Tours",
      companyPhone: "+374 10 530053",
      companyEmail: "info@naretravel.am",
      companyAddress: "15 Abovyan St, Yerevan, Armenia",
      companyWebsite: "www.naretravel.am",
      brandColor: "#0d4f8b",
    });
  });

  // W3 (travel-nare): when the travel WhatsApp account has a public number
  // configured, the frozen contact phone is that number — not
  // TravelSettings.companyPhone. Runs last: it mutates the shared nare row.
  it("freezes the travel account's publicNumber as companyPhone when configured", async () => {
    const { ensureDefaultAccounts } = await import("@/lib/whatsapp-accounts");
    await ensureDefaultAccounts();
    await prisma.whatsAppAccount.update({
      where: { key: "nare" },
      data: { publicNumber: "+374 98 765432" },
    });
    await prisma.travelSettings.upsert({
      where: { id: "default" },
      update: { companyName: "Nare Travel & Tours", companyPhone: "+374 10 530053" },
      create: { id: "default", companyName: "Nare Travel & Tours", companyPhone: "+374 10 530053" },
    });
    const { request, version } = await draftRequest();

    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, {
      ...scenarioContent(fx.hotel.id, fx.hotel.name),
    });
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    await workflow.submit(actorOf(fx.advisor), request.id);

    const snap = await prisma.calculationSnapshot.findUnique({ where: { versionId: version.id } });
    const frozen = JSON.parse(snap!.displayJson!);
    expect(frozen.branding.companyPhone).toBe("+374 98 765432");
    expect(frozen.branding.companyName).toBe("Nare Travel & Tours");
  });
});
