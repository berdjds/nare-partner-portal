/**
 * Phase 1: admin creation/update of PARTNER accounts (one agency, validated),
 * session revocation on agency change, and the landing redirects (no loop).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));

let prisma: PrismaClient;
let admin: any, agencyA: any, agencyOff: any;
let users: typeof import("@/app/api/users/route");

const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null; };
const json = (method: string, body: unknown) => new NextRequest("http://t/api/users", { method, body: JSON.stringify(body) });
const PW = "Str0ng-Passw0rd!xyz";

beforeAll(async () => {
  ensureSchema();
  prisma = await getPrisma();
  users = await import("@/app/api/users/route");
  admin = await prisma.user.create({ data: { email: "adm@t.io", name: "Adm", password: "x", role: "ADMIN" } });
  agencyA = await prisma.agency.create({ data: { shortCode: "AGA", name: "A" } });
  agencyOff = await prisma.agency.create({ data: { shortCode: "AGO", name: "Off", active: false } });
});
beforeEach(() => as(admin));

describe("users API and PARTNER", () => {
  it("creates a partner bound to one active agency", async () => {
    const res = await users.POST(json("POST", { email: "p1@t.io", name: "P1", password: PW, role: "PARTNER", agencyId: agencyA.id }));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await res.json()).agencyId).toBe(agencyA.id);
  });
  it("rejects a partner without an agency, with an inactive or unknown agency", async () => {
    for (const agencyId of [undefined, agencyOff.id, "nope"]) {
      const res = await users.POST(json("POST", { email: `bad${String(agencyId)}@t.io`, name: "B", password: PW, role: "PARTNER", agencyId }));
      expect(res.status).toBe(400);
    }
  });
  it("rejects an agency on a non-partner role", async () => {
    const res = await users.POST(json("POST", { email: "adv@t.io", name: "Adv", password: PW, role: "ADVISOR", agencyId: agencyA.id }));
    expect(res.status).toBe(400);
  });
  it("changing a partner's agency, or its role, revokes their sessions; leaving PARTNER clears the agency", async () => {
    const agencyB = await prisma.agency.create({ data: { shortCode: "AGB", name: "B" } });
    const p = await prisma.user.create({ data: { email: "p2@t.io", name: "P2", password: "x", role: "PARTNER", agencyId: agencyA.id } });
    expect((await users.PATCH(json("PATCH", { id: p.id, agencyId: agencyB.id }))).status).toBe(200);
    let row = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.agencyId).toBe(agencyB.id);
    expect(row.sessionVersion).toBe(1);
    expect((await users.PATCH(json("PATCH", { id: p.id, role: "ADVISOR" }))).status).toBe(200);
    row = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.agencyId).toBeNull();
    expect(row.sessionVersion).toBe(2);
  });
});

describe("landing redirects for PARTNER (no redirect loop)", () => {
  it("/, /dashboard, /travel and /calculator all go to /partner", async () => {
    const p = await prisma.user.create({ data: { email: "p3@t.io", name: "P3", password: "x", role: "PARTNER", agencyId: agencyA.id } });
    as(p);
    const pages = [
      (await import("@/app/page")).default,
      (await import("@/app/dashboard/page")).default,
      (await import("@/app/travel/page")).default,
      (await import("@/app/calculator/page")).default,
    ];
    for (const Page of pages) await expect((Page as any)()).rejects.toThrow("REDIRECT:/partner");
  });
  it("/partner sends staff away and a partner with no valid agency to login", async () => {
    const Partner = (await import("@/app/partner/page")).default;
    as(admin);
    await expect(Partner()).rejects.toThrow("REDIRECT:/");
    const p = await prisma.user.create({ data: { email: "p4@t.io", name: "P4", password: "x", role: "PARTNER", agencyId: agencyOff.id } });
    as(p);
    await expect(Partner()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("/calculator: internal costing tool, server-side gate (travel.internal.view)", () => {
  async function visit(user: any) {
    as(user);
    const Page = (await import("@/app/calculator/page")).default;
    try { await (Page as any)(); return "RENDER"; } catch (e: any) { return String(e.message); }
  }
  it("ADMIN and VALIDATOR render; plain USER, ADVISOR, PARTNER and signed-out are redirected", async () => {
    const mk = (role: string, extra: any = {}) => prisma.user.create({ data: { email: `c-${role}-${Math.random()}@t.io`, name: role, password: "x", role, ...extra } });
    expect(await visit(await mk("ADMIN"))).toBe("RENDER");
    expect(await visit(await mk("VALIDATOR"))).toBe("RENDER");
    expect(await visit(await mk("ADVISOR"))).toBe("REDIRECT:/");
    expect(await visit(await mk("USER"))).toBe("REDIRECT:/");
    expect(await visit(await mk("PARTNER", { agencyId: agencyA.id }))).toBe("REDIRECT:/partner");
    expect(await visit(null)).toBe("REDIRECT:/login");
  });
  it("an ADVISOR with an explicit grant renders; a VALIDATOR with the key denied is refused", async () => {
    const adv = await prisma.user.create({ data: { email: "cg@t.io", name: "G", password: "x", role: "ADVISOR", permissions: { create: [{ key: "travel.internal.view", allowed: true }] } } });
    expect(await visit(adv)).toBe("RENDER");
    const val = await prisma.user.create({ data: { email: "cv@t.io", name: "V", password: "x", role: "VALIDATOR", permissions: { create: [{ key: "travel.internal.view", allowed: false }] } } });
    expect(await visit(val)).toBe("REDIRECT:/");
  });
  it("no other route serves the calculator workbook (no API, no static copy)", async () => {
    const { readdirSync, statSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const hits: string[] = [];
    (function walk(d: string) {
      for (const n of readdirSync(d)) {
        if (["node_modules", ".next", ".git", "tests", "doc"].includes(n)) continue;
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js)$/.test(n) && readFileSync(p, "utf8").includes("Hello_Armenia_Package_Calculator")) hits.push(path.relative(root, p));
      }
    })(root);
    expect(hits).toEqual(["app/calculator/page.tsx"]);
    expect(statSync(path.join(root, "public")).isDirectory()).toBe(true);
    expect(() => statSync(path.join(root, "public", "Hello_Armenia_Package_Calculator_2026_v3.html"))).toThrow();
  });
});
