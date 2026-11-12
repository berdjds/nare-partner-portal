/** Phase 3 review fix: a failed rule application after instantiate is logged and reported, never silent. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { actorOf, createRequestInput, seedFixtures, type Fixtures } from "../workflow/fixtures";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ providerId: "x" })) }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn(async () => ({ id: { _serialized: "wa" } })) }));
vi.mock("@/lib/travel/workflow", async (orig) => {
  const real: any = await orig();
  return { ...real, recalculateFromTemplate: vi.fn(async () => { throw new real.WorkflowError("CONFLICT", "boom with internal detail", 409); }) };
});

let prisma: PrismaClient, fx: Fixtures;
beforeAll(async () => { ensureSchema(); prisma = await getPrisma(); fx = await seedFixtures(prisma); });

describe("instantiate when the rules cannot be applied", () => {
  it("still creates the request (201), logs the cause, and reports only a code to the client", async () => {
    const t = await prisma.packageTemplate.create({ data: { code: "FAIL-1", name: "F" } });
    const tv = await prisma.templateVersion.create({ data: { templateId: t.id, nights: 3, days: 4, daysJson: "[]" } });
    sessionRef.current = { user: { id: fx.advisor.id, role: "ADVISOR", email: fx.advisor.email, name: fx.advisor.name, sv: 0 }, expires: "2099-01-01" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("@/app/api/travel/templates/[id]/instantiate/route");
    const res = await POST(new NextRequest("http://t/i", { method: "POST", body: JSON.stringify({ ...createRequestInput(fx.agency.id), templateVersionId: tv.id }) }), { params: Promise.resolve({ id: t.id }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.recalculation).toEqual({ error: "CONFLICT" });
    expect(JSON.stringify(body)).not.toContain("internal detail");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
