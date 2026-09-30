/**
 * QA: structured template content + instantiate (v0.11.0, Parts C/D).
 *
 * - Instantiate maps catalog-linked day services into shared ServiceLines via
 *   the day-linked sync (quantity stays on the day until Part E), and legacy
 *   plain-string services still normalize.
 * - scenariosJson replaces the skeleton "Option A"/TBD stay with dated stays
 *   derived from checkInOffset/nights against the request startDate.
 * - The title falls back to the template name when blank/omitted.
 * - PUT /api/travel/templates/[id]/versions/[versionId]: ADMIN-only, zod
 *   validation, nights/days recomputed from the edited content.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { createRequestInput, seedFixtures, START_DATE, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "smtp-test" })) }));
vi.mock("@/lib/whatsapp", () => ({
  sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa-test" } })),
}));
vi.mock("@/lib/travel/pdf/render", () => ({
  renderQuotationPdf: vi.fn(async () => Buffer.from("%PDF-1.4 fake")),
}));

let prisma: PrismaClient;
let fx: Fixtures;
let ticket: { id: string; name: string };
let tour: { id: string; name: string };
let vehicle: { id: string };
let template: { id: string };
let version: { id: string };
let legacyVersion: { id: string };

let instantiateRoute: typeof import("@/app/api/travel/templates/[id]/instantiate/route");
let versionRoute: typeof import("@/app/api/travel/templates/[id]/versions/[versionId]/route");

function session(user: { id: string; role: string; email: string; name: string | null } | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const TEMPLATE_ALLOC = { roomType: "DBL", rooms: 1, adults: 2, children: 0, infants: 0, extraBeds: 0 };

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  fx = await seedFixtures(prisma);

  ticket = await prisma.serviceProduct.create({
    data: { name: "Garni Temple ticket", category: "TICKETS", basis: "PER_PERSON" },
  });
  tour = await prisma.serviceProduct.create({
    data: { name: "Private city tour", category: "TRANSPORTATION", basis: "VEHICLE_TRIP" },
  });
  vehicle = await prisma.vehicleType.create({ data: { name: "Minivan", seats: 6 } });

  template = await prisma.packageTemplate.create({ data: { code: "TST-S26-0203A", name: "Test Package 2N" } });
  version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      versionNo: 1,
      nights: 2,
      days: 3,
      daysJson: JSON.stringify([
        {
          dayOffset: 0,
          narrative: "Arrival",
          overnightCity: "Yerevan",
          services: [
            { serviceProductId: ticket.id, label: ticket.name, quantity: 2 },
            { serviceProductId: tour.id, label: tour.name, vehicleTypeId: vehicle.id },
            "Welcome dinner", // legacy plain string
          ],
        },
        { dayOffset: 1, narrative: null, overnightCity: "Yerevan", services: null },
        { dayOffset: 2, narrative: "Departure", overnightCity: null, services: [] },
      ]),
      scenariosJson: JSON.stringify([
        {
          key: "A",
          label: "Base",
          stays: [
            {
              hotelProductId: fx.hotel.id,
              board: "BB",
              checkInOffset: 0,
              nights: 2,
              allocations: [TEMPLATE_ALLOC],
            },
          ],
        },
      ]),
    },
  });
  legacyVersion = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      versionNo: 2,
      nights: 3,
      days: 4,
      status: "ARCHIVED",
      daysJson: JSON.stringify([
        { dayOffset: 0, narrative: "Day one", services: ["Old-style label"] },
        { dayOffset: 1 },
        { dayOffset: 2 },
        { dayOffset: 3 },
      ]),
    },
  });

  instantiateRoute = await import("@/app/api/travel/templates/[id]/instantiate/route");
  versionRoute = await import("@/app/api/travel/templates/[id]/versions/[versionId]/route");
});

beforeEach(() => session(null));

function instantiate(body: unknown) {
  return instantiateRoute.POST(req(`http://t/api/travel/templates/${template.id}/instantiate`, { method: "POST", body }), {
    params: Promise.resolve({ id: template.id }),
  });
}

describe("instantiate with structured content", () => {
  it("copies days verbatim and turns catalog-linked services into shared service lines", async () => {
    session(fx.advisor);
    const res = await instantiate({ ...createRequestInput(fx.agency.id), templateVersionId: version.id });
    expect(res.status).toBe(201);
    const { versionId } = await res.json();

    const days = await prisma.itineraryDay.findMany({ where: { versionId }, orderBy: { dayOffset: "asc" } });
    expect(days).toHaveLength(3);
    expect(days[0].date).toBe(START_DATE);
    const day0Services = JSON.parse(days[0].services!);
    // Catalog links and quantity survive; the legacy string normalized to a label object.
    expect(day0Services[0]).toMatchObject({ serviceProductId: ticket.id, quantity: 2 });
    expect(day0Services[1]).toMatchObject({ serviceProductId: tour.id, vehicleTypeId: vehicle.id });
    expect(day0Services[2]).toMatchObject({ label: "Welcome dinner" });

    const lines = await prisma.serviceLine.findMany({ where: { versionId, serviceProductId: { not: null } } });
    expect(lines).toHaveLength(2);
    const ticketLine = lines.find((l) => l.serviceProductId === ticket.id)!;
    expect(ticketLine.scenarioId).toBeNull();
    expect(ticketLine.date).toBe(START_DATE);
    // Quantity flows from the day service onto the linked line (v0.11.0).
    expect(ticketLine.quantity).toBe("2");
    expect(lines.find((l) => l.serviceProductId === tour.id)?.vehicleTypeId).toBe(vehicle.id);

    const quoteVersion = await prisma.quoteVersion.findUnique({ where: { id: versionId } });
    expect(quoteVersion?.templateVersionId).toBe(version.id);
  });

  it("replaces the skeleton stay with dated stays resolved from offsets", async () => {
    session(fx.advisor);
    const res = await instantiate({ ...createRequestInput(fx.agency.id), templateVersionId: version.id });
    expect(res.status).toBe(201);
    const { versionId } = await res.json();

    const scenarios = await prisma.scenario.findMany({ where: { versionId }, include: { stays: true } });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].label).toBe("Base");
    expect(scenarios[0].stays).toHaveLength(1);
    const stay = scenarios[0].stays[0];
    expect(stay.hotelProductId).toBe(fx.hotel.id);
    expect(stay.hotelName).toBe(fx.hotel.name);
    expect(stay.city).toBe("Yerevan");
    expect(stay.board).toBe("BB");
    expect(stay.checkIn).toBe(START_DATE);
    expect(stay.checkOut).toBe("2026-10-03");
    const alloc = JSON.parse(stay.allocations!)[0];
    expect(alloc).toMatchObject({
      roomType: "DBL",
      rooms: 1,
      adults: 2,
      // Capacity fields filled from the linked hotel product at instantiate.
      capacityAdults: 2,
      capacityChildren: 1,
      capacityTotal: 3,
      extraBedAllowed: true,
    });
  });

  it("defaults the title to the template name when blank or omitted", async () => {
    session(fx.advisor);
    const { title: _fixtureTitle, ...base } = createRequestInput(fx.agency.id);
    for (const title of [undefined, "   "]) {
      const res = await instantiate({
        ...base,
        templateVersionId: version.id,
        ...(title !== undefined ? { title } : {}),
      });
      expect(res.status).toBe(201);
      const { request } = await res.json();
      expect(request.title).toBe("Test Package 2N");
    }
  });

  it("still accepts legacy label-only daysJson", async () => {
    session(fx.advisor);
    const res = await instantiate({ ...createRequestInput(fx.agency.id), templateVersionId: legacyVersion.id });
    expect(res.status).toBe(201);
    const { versionId } = await res.json();
    const days = await prisma.itineraryDay.findMany({ where: { versionId }, orderBy: { dayOffset: "asc" } });
    expect(days).toHaveLength(4);
    expect(JSON.parse(days[0].services!)).toEqual([
      { serviceProductId: null, label: "Old-style label", vehicleTypeId: null, quantity: null },
    ]);
    // No scenariosJson: the skeleton TBD stay survives.
    const scenarios = await prisma.scenario.findMany({ where: { versionId }, include: { stays: true } });
    expect(scenarios[0].stays[0].hotelName).toBe("TBD");
  });

  it("rejects a scenariosJson referencing an unknown hotel product (400)", async () => {
    const broken = await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        versionNo: 3,
        nights: 1,
        days: 2,
        daysJson: JSON.stringify([{ dayOffset: 0 }, { dayOffset: 1 }]),
        scenariosJson: JSON.stringify([
          {
            label: "Broken",
            stays: [
              {
                hotelProductId: "no-such-hotel",
                checkInOffset: 0,
                nights: 1,
                allocations: [TEMPLATE_ALLOC],
              },
            ],
          },
        ]),
      },
    });
    session(fx.advisor);
    const res = await instantiate({ ...createRequestInput(fx.agency.id), templateVersionId: broken.id });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TEMPLATE_HOTEL_UNKNOWN");
  });

  it("VALIDATOR cannot instantiate (403)", async () => {
    session(fx.validator);
    const res = await instantiate({ ...createRequestInput(fx.agency.id), templateVersionId: version.id });
    expect(res.status).toBe(403);
  });
});

describe("template version PUT", () => {
  function put(versionId: string, body: unknown) {
    return versionRoute.PUT(
      req(`http://t/api/travel/templates/${template.id}/versions/${versionId}`, { method: "PUT", body }),
      { params: Promise.resolve({ id: template.id, versionId }) },
    );
  }

  it("is ADMIN-only", async () => {
    session(fx.advisor);
    expect((await put(version.id, { name: "X" })).status).toBe(403);
    session(null);
    expect((await put(version.id, { name: "X" })).status).toBe(401);
  });

  it("404s when the version belongs to another template", async () => {
    const other = await prisma.packageTemplate.create({ data: { code: "TST-S26-9999Z", name: "Other" } });
    session(fx.admin);
    const res = await versionRoute.PUT(
      req(`http://t/api/travel/templates/${other.id}/versions/${version.id}`, { method: "PUT", body: { name: "X" } }),
      { params: Promise.resolve({ id: other.id, versionId: version.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("rejects malformed content (400)", async () => {
    session(fx.admin);
    expect((await put(version.id, { days: [{ dayOffset: 0, services: [{ quantity: 2 }] }] })).status).toBe(400);
    expect((await put(version.id, { scenarios: [{ label: "X", stays: [] }] })).status).toBe(400);
  });

  it("updates name, days and scenarios; nights/days recompute from content", async () => {
    session(fx.admin);
    const res = await put(version.id, {
      name: "Renamed Package",
      days: [0, 1, 2, 3, 4].map((dayOffset) => ({ dayOffset, narrative: `Day ${dayOffset + 1}` })),
      scenarios: null,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // No scenarios: 5 day rows = 4 nights / 5 days (last row = departure day).
    expect(body.nights).toBe(4);
    expect(body.days).toBe(5);
    expect(body.scenariosJson).toBeNull();

    const tpl = await prisma.packageTemplate.findUnique({ where: { id: template.id } });
    expect(tpl?.name).toBe("Renamed Package");

    // Scenarios are authoritative for nights when present.
    const res2 = await put(version.id, {
      scenarios: [
        {
          label: "Split stay",
          stays: [
            { hotelProductId: fx.hotel.id, checkInOffset: 0, nights: 2, allocations: [TEMPLATE_ALLOC] },
            { hotelName: "Guesthouse", city: "Dilijan", checkInOffset: 2, nights: 3, allocations: [TEMPLATE_ALLOC] },
          ],
        },
      ],
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.nights).toBe(5);
    expect(body2.days).toBe(5); // day rows untouched by the scenarios edit
  });
});
