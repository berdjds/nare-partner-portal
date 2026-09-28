/**
 * QA: template management + request deletion endpoints (v0.12.0).
 *
 * - POST /travel/templates: ADMIN-only create with auto version 1 (nights+1
 *   empty day slots), zod validation, duplicate code → 409.
 * - POST /travel/templates/[id]/duplicate: copies latest version content into
 *   CODE-COPY (incremented when taken); 404 for unknown template.
 * - DELETE /travel/templates/[id]: removes template + versions; 403/404 paths.
 * - DELETE /travel/requests/[id]: ADMIN-only hard delete of the request and
 *   all children (versions, scenarios, stays, days, lines, snapshot,
 *   decisions, documents, assignments, events, deliveries); 403 for
 *   non-admin, 404 for unknown id.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, saveContent, scenarioContent, seedFixtures, type Fixtures } from "../workflow/fixtures";

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
let workflow: typeof import("@/lib/travel/workflow");
let fx: Fixtures;

let templatesRoute: typeof import("@/app/api/travel/templates/route");
let templateByIdRoute: typeof import("@/app/api/travel/templates/[id]/route");
let duplicateRoute: typeof import("@/app/api/travel/templates/[id]/duplicate/route");
let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");

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

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  templatesRoute = await import("@/app/api/travel/templates/route");
  templateByIdRoute = await import("@/app/api/travel/templates/[id]/route");
  duplicateRoute = await import("@/app/api/travel/templates/[id]/duplicate/route");
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
});

beforeEach(() => session(null));

describe("POST /travel/templates", () => {
  it("ADMIN creates a template with auto version 1 (nights+1 empty day slots)", async () => {
    session(fx.admin);
    const res = await templatesRoute.POST(req("http://t/api/travel/templates", {
      method: "POST",
      body: { code: "new-s26-0405a", name: "New package", nights: 4 },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toBe("NEW-S26-0405A"); // codes normalize to uppercase
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].nights).toBe(4);
    expect(body.versions[0].days).toBe(5);
    expect(JSON.parse(body.versions[0].daysJson)).toHaveLength(5);
  });

  it("rejects non-ADMIN with 403 and duplicate codes with 409", async () => {
    session(fx.advisor);
    const forbidden = await templatesRoute.POST(req("http://t/api/travel/templates", {
      method: "POST",
      body: { code: "X-1", name: "Nope", nights: 2 },
    }));
    expect(forbidden.status).toBe(403);

    session(fx.admin);
    const dupe = await templatesRoute.POST(req("http://t/api/travel/templates", {
      method: "POST",
      body: { code: "new-s26-0405a", name: "Again", nights: 4 },
    }));
    expect(dupe.status).toBe(409);

    const invalid = await templatesRoute.POST(req("http://t/api/travel/templates", {
      method: "POST",
      body: { code: "", name: "", nights: 0 },
    }));
    expect(invalid.status).toBe(400);
  });
});

describe("POST /travel/templates/[id]/duplicate", () => {
  it("copies the latest version content into CODE-COPY, incrementing when taken", async () => {
    session(fx.admin);
    const source = await prisma.packageTemplate.create({
      data: {
        code: "DUP-S26-0101A",
        name: "Source package",
        versions: {
          create: {
            versionNo: 1,
            nights: 2,
            days: 3,
            daysJson: JSON.stringify([{ dayOffset: 0, narrative: "Arrival" }]),
            scenariosJson: JSON.stringify([{ label: "Option A", stays: [] }]),
          },
        },
      },
    });

    const res = await duplicateRoute.POST(req(`http://t/api/travel/templates/${source.id}/duplicate`, { method: "POST" }), {
      params: Promise.resolve({ id: source.id }),
    });
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy.code).toBe("DUP-S26-0101A-COPY");
    expect(copy.name).toBe("Source package (copy)");
    expect(copy.versions).toHaveLength(1);
    expect(copy.versions[0].daysJson).toContain("Arrival");
    expect(copy.versions[0].scenariosJson).toContain("Option A");

    const res2 = await duplicateRoute.POST(req(`http://t/api/travel/templates/${source.id}/duplicate`, { method: "POST" }), {
      params: Promise.resolve({ id: source.id }),
    });
    expect(res2.status).toBe(201);
    expect((await res2.json()).code).toBe("DUP-S26-0101A-COPY-2");
  });

  it("404 for unknown template, 403 for non-ADMIN", async () => {
    session(fx.admin);
    const missing = await duplicateRoute.POST(req("http://t/api/travel/templates/nope/duplicate", { method: "POST" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);

    session(fx.validator);
    const forbidden = await duplicateRoute.POST(req("http://t/api/travel/templates/x/duplicate", { method: "POST" }), {
      params: Promise.resolve({ id: "x" }),
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("DELETE /travel/templates/[id]", () => {
  it("ADMIN deletes template + versions; 403 for non-ADMIN; 404 after delete", async () => {
    const template = await prisma.packageTemplate.create({
      data: {
        code: "DEL-S26-0101A",
        name: "Delete me",
        versions: { create: { versionNo: 1, nights: 1, days: 2, daysJson: "[]" } },
      },
      include: { versions: true },
    });

    session(fx.advisor);
    const forbidden = await templateByIdRoute.DELETE(req(`http://t/api/travel/templates/${template.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: template.id }),
    });
    expect(forbidden.status).toBe(403);

    session(fx.admin);
    const res = await templateByIdRoute.DELETE(req(`http://t/api/travel/templates/${template.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: template.id }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.packageTemplate.findUnique({ where: { id: template.id } })).toBeNull();
    expect(await prisma.templateVersion.count({ where: { templateId: template.id } })).toBe(0);

    const again = await templateByIdRoute.DELETE(req(`http://t/api/travel/templates/${template.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: template.id }),
    });
    expect(again.status).toBe(404);
  });
});

describe("DELETE /travel/requests/[id]", () => {
  async function deletableRequest() {
    const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
    await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    return { request, version };
  }

  it("403 for non-ADMIN, 404 for unknown id", async () => {
    const { request } = await deletableRequest();
    session(fx.advisor);
    const forbidden = await requestByIdRoute.DELETE(req(`http://t/api/travel/requests/${request.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: request.id }),
    });
    expect(forbidden.status).toBe(403);

    session(fx.admin);
    const missing = await requestByIdRoute.DELETE(req("http://t/api/travel/requests/nope", { method: "DELETE" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("ADMIN hard-deletes the request and every child row", async () => {
    const { request, version } = await deletableRequest();
    await workflow.submit(actorOf(fx.advisor), request.id); // adds snapshot + INTERNAL document + events/deliveries

    session(fx.admin);
    const res = await requestByIdRoute.DELETE(req(`http://t/api/travel/requests/${request.id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: request.id }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.travelRequest.findUnique({ where: { id: request.id } })).toBeNull();
    expect(await prisma.quoteVersion.count({ where: { requestId: request.id } })).toBe(0);
    expect(await prisma.scenario.count({ where: { versionId: version.id } })).toBe(0);
    expect(await prisma.staySegment.count({ where: { scenario: { versionId: version.id } } })).toBe(0);
    expect(await prisma.itineraryDay.count({ where: { versionId: version.id } })).toBe(0);
    expect(await prisma.serviceLine.count({ where: { versionId: version.id } })).toBe(0);
    expect(await prisma.calculationSnapshot.count({ where: { versionId: version.id } })).toBe(0);
    expect(await prisma.quoteDocument.count({ where: { versionId: version.id } })).toBe(0);
    expect(await prisma.validationAssignment.count({ where: { requestId: request.id } })).toBe(0);
    expect(await prisma.workflowEvent.count({ where: { requestId: request.id } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { event: { requestId: request.id } } })).toBe(0);

    const audit = await prisma.log.findFirst({
      where: { action: "TRAVEL_REQUEST_DELETED" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.details).toContain(request.packageCode);
  });
});
