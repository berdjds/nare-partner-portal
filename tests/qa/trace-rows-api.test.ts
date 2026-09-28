/**
 * QA: calculation trace rows in the API (v0.15.0).
 *
 * - POST /api/travel/versions/[id]/calculate attaches a response-only
 *   `traceRows` breakdown per scenario (never persisted, never part of the
 *   frozen ScenarioResult contract).
 * - GET /api/travel/requests/[id] rebuilds the same rows from the frozen
 *   snapshot (inputsJson + per-scenario resultJson) for submitted versions —
 *   and never leaks the snapshot's inputsJson itself.
 * - Pre-submit versions carry no traceRows (there is no frozen snapshot yet).
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
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

let calculateRoute: typeof import("@/app/api/travel/versions/[id]/calculate/route");
let requestByIdRoute: typeof import("@/app/api/travel/requests/[id]/route");

function session(user: { id: string; role: string; email: string; name: string | null } | null) {
  sessionRef.current = user
    ? { user: { id: user.id, role: user.role, email: user.email, name: user.name }, expires: "2099-01-01" }
    : null;
}

function post(url: string, body: unknown) {
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body) });
}

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  workflow = await import("@/lib/travel/workflow");
  fx = await seedFixtures(prisma);
  calculateRoute = await import("@/app/api/travel/versions/[id]/calculate/route");
  requestByIdRoute = await import("@/app/api/travel/requests/[id]/route");
});

/** Draft request owned by the fixture advisor with one hotel scenario saved. */
async function draftVersion() {
  const { request, version } = await workflow.createRequest(actorOf(fx.advisor), createRequestInput(fx.agency.id));
  await saveContent(prisma, actorOf(fx.advisor), request.id, version.id, scenarioContent(fx.hotel.id, fx.hotel.name));
  return { request, version };
}

describe("calculation trace rows", () => {
  it("calculate attaches a response-only traceRows breakdown per scenario", async () => {
    const { version } = await draftVersion();
    session(fx.advisor);
    const res = await calculateRoute.POST(post(`http://localhost/api/travel/versions/${version.id}/calculate`, {}), {
      params: Promise.resolve({ id: version.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const sc = body.scenarios[0];
    expect(Array.isArray(sc.traceRows)).toBe(true);
    const descriptions = sc.traceRows.map((r: any) => r.description);
    // 3 nights × 100 USD on the fixture hotel.
    expect(descriptions[0]).toBe("Test Hotel — DBL, 01-Oct-2026 → 03-Oct-2026 (3 nights)");
    expect(sc.traceRows[0].amount).toBe("300 USD");
    // Bold Sell/Profit close the table; totals are muted.
    const sell = sc.traceRows[sc.traceRows.length - 2];
    const profit = sc.traceRows[sc.traceRows.length - 1];
    expect(sell).toMatchObject({ description: "Sell", bold: true });
    expect(profit).toMatchObject({ description: "Profit", bold: true });
    expect(sc.traceRows.find((r: any) => r.description === "Total Net USD")?.muted).toBe(true);
    // The sell row amount matches the scenario's authoritative sell figure.
    expect(sell.amount).toBe(`${Number(sc.sell).toLocaleString("en-US")} USD`);
  });

  it("detail GET exposes no traceRows before submit", async () => {
    const { request } = await draftVersion();
    session(fx.advisor);
    const res = await requestByIdRoute.GET(new NextRequest(`http://localhost/api/travel/requests/${request.id}`), {
      params: Promise.resolve({ id: request.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions[0].snapshot).toBeNull();
    expect(body.versions[0].scenarios[0].traceRows).toBeUndefined();
  });

  it("detail GET rebuilds the frozen traceRows from the snapshot after submit", async () => {
    const { request } = await draftVersion();
    await workflow.assignValidator(actorOf(fx.advisor), request.id, { validatorId: fx.validator.id });
    await workflow.submit(actorOf(fx.advisor), request.id);

    session(fx.advisor);
    const res = await requestByIdRoute.GET(new NextRequest(`http://localhost/api/travel/requests/${request.id}`), {
      params: Promise.resolve({ id: request.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const version = body.versions[0];
    const scenario = version.scenarios[0];

    expect(Array.isArray(scenario.traceRows)).toBe(true);
    const sell = scenario.traceRows[scenario.traceRows.length - 2];
    expect(sell).toMatchObject({ description: "Sell", bold: true });
    // Frozen: the trace matches the persisted scenario result, not live rates.
    const result = JSON.parse(scenario.resultJson);
    expect(sell.amount).toBe(`${Number(result.sell).toLocaleString("en-US")} USD`);

    // The snapshot's frozen engine input is consumed server-side only.
    expect(version.snapshot).toBeTruthy();
    expect(version.snapshot.inputsJson).toBeUndefined();

    // The assigned validator (full-costing role) sees the same frozen rows.
    session(fx.validator);
    const resV = await requestByIdRoute.GET(new NextRequest(`http://localhost/api/travel/requests/${request.id}`), {
      params: Promise.resolve({ id: request.id }),
    });
    const bodyV = await resV.json();
    expect(bodyV.versions[0].scenarios[0].traceRows?.length).toBe(scenario.traceRows.length);
  });
});
