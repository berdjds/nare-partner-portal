/** Phase 3: routed page guard, modal removal, labels and review wording. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ensureSchema, getPrisma } from "../travel-db/helpers";
import { reviewItems } from "@/lib/travel/review-flags";

const { sessionRef } = vi.hoisted(() => ({ sessionRef: { current: null as any } }));
vi.mock("next-auth/next", () => ({ getServerSession: vi.fn(async () => sessionRef.current) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
const src = (p: string) => readFileSync(path.resolve(__dirname, "../..", p), "utf8");
let prisma: PrismaClient;
const as = (u: any) => { sessionRef.current = u ? { user: { id: u.id, role: u.role, email: u.email, name: u.name, sv: u.sessionVersion ?? 0 }, expires: "2099-01-01" } : null; };

beforeAll(async () => { ensureSchema(); prisma = await getPrisma(); });
beforeEach(() => as(null));

describe("/travel/requests/new guard", () => {
  async function visit(user: any) {
    as(user);
    const Page = (await import("@/app/travel/requests/new/page")).default;
    try { await (Page as any)(); return "RENDER"; } catch (e: any) { return String(e.message); }
  }
  it("ADMIN and ADVISOR render; VALIDATOR, USER, PARTNER and signed-out are redirected", async () => {
    const agency = await prisma.agency.create({ data: { shortCode: "NRP", name: "N" } });
    const mk = (role: string, extra: any = {}) => prisma.user.create({ data: { email: `n-${role}-${Math.random()}@t.io`, name: role, password: "x", role, ...extra } });
    expect(await visit(await mk("ADMIN"))).toBe("RENDER");
    expect(await visit(await mk("ADVISOR"))).toBe("RENDER");
    expect(await visit(await mk("VALIDATOR"))).toBe("REDIRECT:/travel");
    expect(await visit(await mk("USER"))).toBe("REDIRECT:/dashboard");
    expect(await visit(await mk("PARTNER", { agencyId: agency.id }))).toBe("REDIRECT:/partner");
    expect(await visit(null)).toBe("REDIRECT:/login");
  });
  it("an advisor denied travel.create is sent back to the list", async () => {
    const adv = await prisma.user.create({ data: { email: "nc@t.io", name: "A", password: "x", role: "ADVISOR", permissions: { create: [{ key: "travel.create", allowed: false }] } } });
    expect(await visit(adv)).toBe("REDIRECT:/travel");
  });
});

describe("modal replaced by the page", () => {
  it("the requests list links to the routed page and no longer contains the create dialog", () => {
    const list = src("components/travel/RequestsList.tsx");
    expect(list).toContain('href="/travel/requests/new"');
    expect(list).not.toContain("New travel request");
    expect(list).not.toContain("createOpen");
    expect(list).not.toContain("handleCreate");
  });
  it("the page uses the required wording, sections, error semantics and a double-submit guard", () => {
    const page = src("components/travel/NewRequestPage.tsx");
    expect(page).toContain("Client messages and notes");
    expect(page).toContain("Internal notes");
    expect(page).not.toMatch(/<Label[^>]*>\s*Notes\s*</);
    for (const s of ["Agency", "Dates &amp; template", "Travellers", "Client requirements", "Review"]) expect(page).toContain(s);
    expect(page).toContain('role="alert"');
    expect(page).toContain("aria-invalid");
    expect(page).toContain("inFlight.current");
    expect(page).toContain("beforeunload");
    expect(page).toContain("sessionStorage");
    expect(page).not.toContain("<Dialog");
  });
  it("the detail overview labels the two notes distinctly", () => {
    const ov = src("components/travel/detail/OverviewTab.tsx");
    expect(ov).toContain("Client messages and notes");
    expect(ov).toContain("Internal notes (staff only)");
  });
});

describe("reviewItems", () => {
  it("maps flags to words, lists inactive lines separately and ignores clean lines", () => {
    const items = reviewItems([
      { id: "1", label: "Group tour", date: "2026-10-06", reviewFlag: "BELOW_MIN,WEEKDAY_UNAVAILABLE" },
      { id: "2", label: "Leader meal", date: "2026-10-01", ruleInactive: true },
      { id: "3", label: "Museum", date: null },
      { id: "4", label: "X", date: null, reviewFlag: "SOMETHING_NEW" },
    ]);
    expect(items.map((i) => [i.id, i.kind])).toEqual([["1", "review"], ["2", "inactive"], ["4", "review"]]);
    expect(items[0].reasons).toHaveLength(2);
    expect(items[2].reasons).toEqual(["needs review"]);
  });
});
