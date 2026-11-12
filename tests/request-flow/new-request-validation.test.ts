/** Phase 3: client-safe validation for the routed new-request page (mirrors the server schema). */
import { describe, expect, it } from "vitest";
import { validateNewRequest, hasErrors, firstErrorId, EMPTY_NEW_REQUEST, type NewRequestForm } from "@/lib/travel/new-request-form";

const ok = (o: Partial<NewRequestForm> = {}): NewRequestForm => ({
  ...EMPTY_NEW_REQUEST, agencyId: "a1", title: "Trip", startDate: "2026-10-01", endDate: "2026-10-04",
  travelers: { adults: 2, children: 0, infants: 0, childAges: [], paying: 2, complimentary: 0, leaders: 0, staff: 0 }, ...o,
});

describe("validateNewRequest", () => {
  it("a complete form has no errors", () => expect(hasErrors(validateNewRequest(ok()))).toBe(false));
  it("requires agency, title and both dates, each with its own message", () => {
    const e = validateNewRequest(ok({ agencyId: "", title: "  ", startDate: "", endDate: "" }));
    expect(Object.keys(e).sort()).toEqual(["agencyId", "endDate", "startDate", "title"]);
  });
  it("end must be after start (equal is invalid)", () => {
    expect(validateNewRequest(ok({ endDate: "2026-10-01" })).endDate).toMatch(/after/);
    expect(validateNewRequest(ok({ endDate: "2026-09-30" })).endDate).toMatch(/after/);
    expect(validateNewRequest(ok({ endDate: "2026-10-02" })).endDate).toBeUndefined();
  });
  it("rejects malformed dates", () => expect(validateNewRequest(ok({ startDate: "01/10/2026" })).startDate).toBeTruthy());
  it("child ages for every child, infants within children", () => {
    const t = (o: object) => ({ ...ok().travelers, ...o });
    expect(validateNewRequest(ok({ travelers: t({ children: 2, childAges: [5] }) })).travelers).toMatch(/age/i);
    expect(validateNewRequest(ok({ travelers: t({ children: 1, childAges: [5], infants: 2 }) })).travelers).toMatch(/infants/i);
    expect(validateNewRequest(ok({ travelers: t({ adults: -1 }) })).travelers).toBeTruthy();
  });
  it("does not invent rules: paying may differ from adults + children (the server allows it)", () => {
    expect(hasErrors(validateNewRequest(ok({ travelers: { ...ok().travelers, paying: 5 } })))).toBe(false);
  });
  it("bounds the free text like the server (4000) and the title (200)", () => {
    expect(validateNewRequest(ok({ clientNotes: "x".repeat(4001) })).clientNotes).toBeTruthy();
    expect(validateNewRequest(ok({ notes: "x".repeat(4001) })).notes).toBeTruthy();
    expect(validateNewRequest(ok({ title: "x".repeat(201) })).title).toBeTruthy();
    expect(validateNewRequest(ok({ clientNotes: "x".repeat(4000) })).clientNotes).toBeUndefined();
  });
  it("firstErrorId points at the first invalid field in page order", () => {
    expect(firstErrorId(validateNewRequest(ok({ endDate: "", title: "" })))).toBe("nr-title");
    expect(firstErrorId({})).toBeNull();
  });
});

import { draftKey, clearAllDrafts, DRAFT_PREFIX } from "@/lib/travel/new-request-form";
import { vi } from "vitest";
describe("draft storage", () => {
  it("is scoped per user and clearAllDrafts removes every draft but nothing else", () => {
    const store = new Map<string, string>([[draftKey("u1"), "a"], [draftKey("u2"), "b"], ["other", "keep"]]);
    vi.stubGlobal("sessionStorage", { removeItem: (k: string) => store.delete(k), getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), get length() { return store.size; }, key: (i: number) => Array.from(store.keys())[i] ?? null, clear: () => store.clear() });
    // Object.keys(sessionStorage) is how the helper enumerates; mimic a real Storage
    vi.stubGlobal("sessionStorage", Object.assign(Object.create(null), Object.fromEntries(store), { removeItem: (k: string) => { store.delete(k); delete (globalThis as any).sessionStorage[k]; } }));
    expect(draftKey("u1")).not.toBe(draftKey("u2"));
    expect(draftKey("u1").startsWith(DRAFT_PREFIX)).toBe(true);
    clearAllDrafts();
    expect(Array.from(store.keys())).toEqual(["other"]);
    vi.unstubAllGlobals();
  });
});
