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
  it("needs at least one traveller, child ages for every child, infants within children", () => {
    const t = (o: object) => ({ ...ok().travelers, ...o });
    expect(validateNewRequest(ok({ travelers: t({ adults: 0, children: 0, paying: 0 }) })).travelers).toMatch(/at least one/i);
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
