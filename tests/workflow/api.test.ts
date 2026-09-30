/**
 * Route-level RBAC: a session with the plain USER role and no validation
 * assignment must get 401 from /api/travel routes. getServerSession is
 * mocked; the guard re-reads the user row from the throwaway DB (W1b) and
 * then runs one (empty) assignment lookup before rejecting.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({
  getServerSession: vi.fn(async () => sessionRef.current),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsAppMessage: vi.fn() }));

let prisma: PrismaClient;
let requestsGET: typeof import("@/app/api/travel/requests/route").GET;

beforeAll(async () => {
  // The route module graph pulls in prisma; give it a valid (throwaway) URL.
  ensureSchema();
  prisma = await getPrisma();
  // Since W1b the guard resolves the session against a real user row, so the
  // mocked session must point at one — the 401 below then genuinely comes
  // from the missing validation assignment, not from an unknown user.
  const plain = await prisma.user.create({
    data: { email: "wf-plain@test.io", name: "Plain", password: "x", role: "USER" },
  });
  sessionRef.current = {
    user: { id: plain.id, role: "USER", email: plain.email, name: plain.name },
    expires: "2099-01-01",
  };
  requestsGET = (await import("@/app/api/travel/requests/route")).GET;
});

describe("travel API RBAC", () => {
  it("rejects USER role with 401", async () => {
    const res = await requestsGET(new NextRequest("http://localhost:3000/api/travel/requests"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});
